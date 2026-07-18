const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const emailAdapter = require("../lead-engine/emailAdapter");
const { sendTaskNow } = require("../lead-engine/sendingEngine");

const SMTP_ENV = {
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.gmail.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "sender@example.com",
  SMTP_PASS: "mock-app-pass-placeholder",
  SMTP_FROM: "sender@example.com",
  SMTP_FROM_NAME: "Prince Akpabio | CallCatch",
  SMTP_REPLY_TO: "sender@example.com",
  SMTP_TIMEOUT_MS: "30000"
};

const RESEND_ENV = {
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_mock_api_token",
  RESEND_FROM: "hello@callcatch.site",
  RESEND_FROM_NAME: "Prince Akpabio | CallCatch",
  RESEND_REPLY_TO: "prince@example.com",
  SMTP_HOST: undefined,
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
  SMTP_FROM: undefined,
  SMTP_REPLY_TO: undefined
};

async function withEnv(nextEnv, fn) {
  const previous = {};
  for (const key of Object.keys(nextEnv)) {
    previous[key] = process.env[key];
    if (nextEnv[key] === undefined) delete process.env[key];
    else process.env[key] = nextEnv[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(nextEnv)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function installFakeSmtp({ failAt = "", failMessage = "", ehlo = "250 smtp.gmail.com\r\n250 AUTH LOGIN\r\n" } = {}) {
  const calls = [];
  const writes = [];
  let readCount = 0;
  let startTlsCount = 0;
  emailAdapter.__setEmailLoggerForTests(() => {});
  emailAdapter.__setSmtpClientFactoryForTests(() => ({
    socket: {
      write(value) {
        writes.push(value);
      },
      end() {
        calls.push("END");
      }
    },
    async readResponse() {
      readCount += 1;
      return readCount === 1 ? "220 smtp.gmail.com ESMTP\r\n" : "250 2.0.0 OK queued\r\n";
    },
    async command(line, expected, label = line) {
      calls.push(label);
      if (label === failAt) {
        const error = new Error(failMessage || `SMTP command failed at ${label}: 535 5.7.8 Authentication failed`);
        error.smtpCommand = label;
        error.responseCode = 535;
        throw error;
      }
      if (label === "EHLO" || label === "EHLO_AFTER_STARTTLS") return ehlo;
      if (label === "DATA") return "354 Go ahead\r\n";
      if (label === "QUIT") return "221 2.0.0 closing connection\r\n";
      return `${expected?.[0] || "250"} OK\r\n`;
    },
    async startTls() {
      startTlsCount += 1;
      calls.push("STARTTLS_UPGRADE");
    }
  }));
  return { calls, writes, get startTlsCount() { return startTlsCount; } };
}

test.afterEach(() => {
  emailAdapter.__setSmtpClientFactoryForTests();
  emailAdapter.__setSmtpSocketConnectorsForTests();
  emailAdapter.__setEmailLoggerForTests();
  if (test.originalFetch) global.fetch = test.originalFetch;
});

function mockFetch(responseFactory) {
  test.originalFetch = test.originalFetch || global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : {} });
    return responseFactory(url, options, calls[calls.length - 1]);
  };
  return calls;
}

test("SMTP config parsing keeps Gmail provider and numeric timeout", async () => {
  await withEnv(SMTP_ENV, () => {
    const config = emailAdapter.emailConfig();
    assert.equal(config.provider, "smtp");
    assert.equal(config.host, "smtp.gmail.com");
    assert.equal(config.port, 465);
    assert.equal(config.secure, true);
    assert.equal(config.timeoutMs, 30000);
    assert.equal(emailAdapter.activeProvider(config), "smtp");
    assert.equal(emailAdapter.configured(config), true);
  });
});

test("SMTP_SECURE true and false values parse safely", () => {
  assert.equal(emailAdapter.parseBoolean("true", false), true);
  assert.equal(emailAdapter.parseBoolean("1", false), true);
  assert.equal(emailAdapter.parseBoolean("false", true), false);
  assert.equal(emailAdapter.parseBoolean("0", true), false);
  assert.equal(emailAdapter.parseBoolean("unexpected", true), true);
});

test("SMTP verify supports STARTTLS when secure is false", async () => {
  await withEnv({ ...SMTP_ENV, SMTP_PORT: "587", SMTP_SECURE: "false" }, async () => {
    const fake = installFakeSmtp({ ehlo: "250-smtp.gmail.com\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n" });
    const result = await emailAdapter.verifyEmailTransport();
    assert.equal(result.verified, true);
    assert.equal(fake.startTlsCount, 1);
    assert.ok(fake.calls.includes("AUTH_PASSWORD"));
  });
});

test("send success path uses mocked SMTP transport and never sends real email", async () => {
  await withEnv(SMTP_ENV, async () => {
    const fake = installFakeSmtp();
    const result = await emailAdapter.sendEmail({
      to: "prospect@example.net",
      subject: "CallCatch test",
      body: "This is a mocked test."
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "SMTP");
    assert.ok(fake.calls.includes("AUTH_PASSWORD"));
    assert.ok(fake.writes.some(value => value.includes("Subject: CallCatch test")));
  });
});

test("send failure path returns sanitized SMTP error", async () => {
  await withEnv(SMTP_ENV, async () => {
    installFakeSmtp({
      failAt: "AUTH_PASSWORD",
      failMessage: "SMTP command failed at AUTH_PASSWORD: 535 5.7.8 Username and Password not accepted"
    });
    await assert.rejects(
      () => emailAdapter.sendEmail({ to: "prospect@example.net", subject: "Test", body: "Body" }),
      error => {
        assert.match(error.message, /AUTH_PASSWORD/);
        assert.equal(error.responseCode, 535);
        assert.doesNotMatch(error.message, /mock-app-pass-placeholder/);
        assert.doesNotMatch(error.message, /c3VwZXItc2VjcmV0/);
        return true;
      }
    );
  });
});

test("sendTaskNow marks CRM and audit as sent only after SMTP success", async () => {
  await withEnv(SMTP_ENV, async () => {
    installFakeSmtp();
    const state = {
      leads: [{ id: "lead_1", business: "Mock HVAC", email: "owner@example.net", stage: "New", timeline: [] }],
      approvalQueue: [{ id: "task_1", leadId: "lead_1", channel: "email", status: "Approved", title: "Cold Email", body: "Subject: Hi\n\nBody" }],
      auditLog: []
    };
    const result = await sendTaskNow(state, "task_1");
    assert.equal(result.sent, true);
    assert.equal(state.approvalQueue[0].status, "Sent");
    assert.equal(state.leads[0].stage, "Contacted");
    assert.equal(state.leads[0].sentEmails.length, 1);
    assert.equal(state.auditLog[0].action, "email_sent");
  });
});

test("failed send is not marked as sent and records sanitized CRM failure", async () => {
  await withEnv(SMTP_ENV, async () => {
    installFakeSmtp({ failAt: "AUTH_PASSWORD" });
    const state = {
      leads: [{ id: "lead_1", business: "Mock HVAC", email: "owner@example.net", stage: "New", timeline: [] }],
      approvalQueue: [{ id: "task_1", leadId: "lead_1", channel: "email", status: "Approved", title: "Cold Email", body: "Subject: Hi\n\nBody" }],
      auditLog: []
    };
    const result = await sendTaskNow(state, "task_1");
    assert.equal(result.sent, false);
    assert.equal(result.failed, true);
    assert.equal(state.approvalQueue[0].status, "Send Failed");
    assert.equal(state.leads[0].stage, "New");
    assert.equal(state.leads[0].sentEmails, undefined);
    assert.equal(state.auditLog[0].action, "email_send_failed");
    assert.doesNotMatch(state.approvalQueue[0].error, /mock-app-pass-placeholder/);
  });
});

test("nested AggregateError sanitization preserves safe socket diagnostics only", () => {
  const ipv6 = new Error("connect ENETUNREACH 2607:f8b0::1 user@example.com api_key=mock-api-token");
  ipv6.code = "ENETUNREACH";
  ipv6.errno = -101;
  ipv6.syscall = "connect";
  ipv6.hostname = "smtp.gmail.com";
  ipv6.address = "2607:f8b0::1";
  ipv6.port = 465;
  const ipv4 = new Error("connect ETIMEDOUT 142.250.102.109:465");
  ipv4.code = "ETIMEDOUT";
  ipv4.syscall = "connect";
  ipv4.hostname = "smtp.gmail.com";
  ipv4.address = "142.250.102.109";
  ipv4.port = 465;
  const aggregate = new AggregateError([ipv6], "SMTP connect failed");
  aggregate.cause = ipv4;

  const safe = emailAdapter.sanitizeEmailError(aggregate);
  assert.equal(safe.name, "AggregateError");
  assert.equal(safe.causes.length, 2);
  assert.deepEqual(
    safe.causes.map(item => item.code).sort(),
    ["ENETUNREACH", "ETIMEDOUT"]
  );
  assert.equal(safe.causes[0].hostname, "smtp.gmail.com");
  assert.equal(safe.causes[0].port, 465);
  assert.doesNotMatch(JSON.stringify(safe), /user@example\.com/);
  assert.doesNotMatch(JSON.stringify(safe), /mock-api-token/);
});

test("SMTP verify falls back to IPv4 after IPv6 AggregateError without sending email", async () => {
  await withEnv(SMTP_ENV, async () => {
    const connectorCalls = [];
    const commands = [];

    function makeSocket({ fail, family }) {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {
        socket.destroyed = true;
      };
      socket.end = () => {
        commands.push("END");
      };
      socket.write = line => {
        commands.push(line.trim());
        const label = line.trim();
        setImmediate(() => {
          if (/^EHLO/i.test(label)) socket.emit("data", Buffer.from("250 smtp.gmail.com\r\n"));
          else if (/^AUTH LOGIN/i.test(label)) socket.emit("data", Buffer.from("334 VXNlcm5hbWU6\r\n"));
          else if (/^QUIT/i.test(label)) socket.emit("data", Buffer.from("221 2.0.0 closing connection\r\n"));
          else if (commands.filter(item => /^[A-Za-z0-9+/]+=*$/.test(item)).length === 1) socket.emit("data", Buffer.from("334 UGFzc3dvcmQ6\r\n"));
          else socket.emit("data", Buffer.from("235 2.7.0 Accepted\r\n"));
        });
      };
      setImmediate(() => {
        if (fail) {
          const ipv6 = new Error("connect ENETUNREACH 2607:f8b0::1");
          ipv6.code = "ENETUNREACH";
          ipv6.syscall = "connect";
          ipv6.hostname = "smtp.gmail.com";
          ipv6.address = "2607:f8b0::1";
          ipv6.port = 465;
          socket.emit("error", new AggregateError([ipv6], "All connection attempts failed"));
        } else {
          socket.emit("data", Buffer.from("220 smtp.gmail.com ESMTP\r\n"));
        }
      });
      socket.family = family || "";
      return socket;
    }

    emailAdapter.__setEmailLoggerForTests(() => {});
    emailAdapter.__setSmtpSocketConnectorsForTests({
      netConnect: options => {
        connectorCalls.push(options);
        return makeSocket({ fail: !options.family, family: options.family });
      },
      tlsConnect: options => {
        connectorCalls.push(options);
        return makeSocket({ fail: !options.family, family: options.family });
      }
    });

    const result = await emailAdapter.verifyEmailTransport();
    assert.equal(result.verified, true);
    assert.equal(connectorCalls.length, 2);
    assert.equal(connectorCalls[0].family, undefined);
    assert.equal(connectorCalls[1].family, 4);
    assert.ok(commands.some(item => /^AUTH LOGIN/i.test(item)));
    assert.ok(!commands.some(item => /^DATA/i.test(item)));
  });
});

test("EMAIL_PROVIDER=resend selects Resend with explicit sender and reply-to", async () => {
  await withEnv(RESEND_ENV, () => {
    const config = emailAdapter.emailConfig();
    assert.equal(emailAdapter.activeProvider(config), "resend");
    assert.equal(emailAdapter.configured(config), true);
    assert.equal(config.from, "hello@callcatch.site");
    assert.equal(config.fromName, "Prince Akpabio | CallCatch");
    assert.equal(config.replyTo, "prince@example.com");
  });
});

test("Resend configuration requires API key and valid From address", async () => {
  await withEnv({ ...RESEND_ENV, RESEND_API_KEY: "" }, () => {
    const config = emailAdapter.emailConfig();
    assert.equal(emailAdapter.configured(config), false);
  });
  await withEnv({ ...RESEND_ENV, RESEND_FROM: "" }, () => {
    const config = emailAdapter.emailConfig();
    assert.equal(emailAdapter.configured(config), false);
  });
});

test("Resend verification is configuration-only and validates Reply-To", async () => {
  await withEnv(RESEND_ENV, async () => {
    const calls = mockFetch(() => {
      throw new Error("Resend verify must not call fetch");
    });
    const result = await emailAdapter.verifyEmailTransport();
    assert.equal(result.verified, true);
    assert.equal(result.mode, "configuration-only");
    assert.equal(result.fromDomain, "callcatch.site");
    assert.equal(result.replyToDomain, "example.com");
    assert.equal(calls.length, 0);
  });

  await withEnv({ ...RESEND_ENV, RESEND_REPLY_TO: "not-an-email" }, async () => {
    await assert.rejects(
      () => emailAdapter.verifyEmailTransport(),
      /Email provider is not configured|RESEND_REPLY_TO/
    );
  });
});

test("mocked Resend success sends formatted From and Reply-To without SMTP attempt", async () => {
  await withEnv(RESEND_ENV, async () => {
    emailAdapter.__setSmtpClientFactoryForTests(() => {
      throw new Error("SMTP must not be used when Resend is selected");
    });
    const calls = mockFetch(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { id: "resend_mock_123" };
      }
    }));
    const result = await emailAdapter.sendEmail({
      to: "owner@example.net",
      subject: "CallCatch test",
      body: "Mocked Resend body"
    });
    assert.equal(result.provider, "Resend");
    assert.equal(result.messageId, "resend_mock_123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].body.from, "\"Prince Akpabio | CallCatch\" <hello@callcatch.site>");
    assert.equal(calls[0].body.reply_to, "\"Prince Akpabio | CallCatch\" <prince@example.com>");
    assert.deepEqual(calls[0].body.to, ["owner@example.net"]);
    assert.equal(calls[0].body.subject, "CallCatch test");
    assert.ok(calls[0].options.headers.Authorization.startsWith("Bearer "));
  });
});

test("mocked Resend failure returns sanitized HTTP status and does not leak API key", async () => {
  await withEnv(RESEND_ENV, async () => {
    mockFetch(async () => ({
      ok: false,
      status: 403,
      async json() {
        return { message: "Domain sender rejected for hello@callcatch.site and token re_mock_api_token" };
      }
    }));
    await assert.rejects(
      () => emailAdapter.sendEmail({ to: "owner@example.net", subject: "Test", body: "Body" }),
      error => {
        assert.equal(error.responseCode, 403);
        assert.doesNotMatch(error.message, /re_mock_api_token/);
        assert.doesNotMatch(error.message, /hello@callcatch\.site/);
        return true;
      }
    );
  });
});

test("sendTaskNow marks CRM and audit as sent after mocked Resend success", async () => {
  await withEnv(RESEND_ENV, async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { id: "resend_sent_task" };
      }
    }));
    const state = {
      leads: [{ id: "lead_resend", business: "Resend HVAC", email: "owner@example.net", stage: "New", timeline: [] }],
      approvalQueue: [{ id: "task_resend", leadId: "lead_resend", channel: "email", status: "Approved", title: "Cold Email", body: "Subject: Hi\n\nBody" }],
      auditLog: []
    };
    const result = await sendTaskNow(state, "task_resend");
    assert.equal(result.sent, true);
    assert.equal(state.approvalQueue[0].status, "Sent");
    assert.equal(state.leads[0].stage, "Contacted");
    assert.equal(state.leads[0].sentEmails[0].provider, "Resend");
    assert.equal(state.auditLog[0].action, "email_sent");
  });
});

test("failed mocked Resend send is not marked as sent", async () => {
  await withEnv(RESEND_ENV, async () => {
    mockFetch(async () => ({
      ok: false,
      status: 422,
      async json() {
        return { message: "Invalid sender" };
      }
    }));
    const state = {
      leads: [{ id: "lead_resend", business: "Resend HVAC", email: "owner@example.net", stage: "New", timeline: [] }],
      approvalQueue: [{ id: "task_resend", leadId: "lead_resend", channel: "email", status: "Approved", title: "Cold Email", body: "Subject: Hi\n\nBody" }],
      auditLog: []
    };
    const result = await sendTaskNow(state, "task_resend");
    assert.equal(result.sent, false);
    assert.equal(result.failed, true);
    assert.equal(result.responseCode, 422);
    assert.equal(state.approvalQueue[0].status, "Send Failed");
    assert.equal(state.leads[0].stage, "New");
    assert.equal(state.leads[0].sentEmails, undefined);
    assert.equal(state.auditLog[0].action, "email_send_failed");
  });
});

test("test-email route requires explicit test flag before send", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "callcatch-lead-server.js"), "utf8");
  assert.match(serverSource, /url\.pathname === "\/api\/email\/send-test"/);
  assert.match(serverSource, /body\.test !== true/);
  assert.match(serverSource, /Test flag is required before sending a test email/);
  assert.match(serverSource, /CallCatch test email - delivery check/);
});
