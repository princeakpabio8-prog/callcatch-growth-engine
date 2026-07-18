const test = require("node:test");
const assert = require("node:assert/strict");

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

async function withEnv(nextEnv, fn) {
  const previous = {};
  for (const key of Object.keys(nextEnv)) {
    previous[key] = process.env[key];
    process.env[key] = nextEnv[key];
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
  emailAdapter.__setEmailLoggerForTests();
});

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
