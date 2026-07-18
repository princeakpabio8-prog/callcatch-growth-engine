const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

let smtpClientFactory = smtpClient;
let emailLogger = entry => console.log(JSON.stringify(entry));
let smtpSocketConnectors = {
  netConnect: options => net.connect(options),
  tlsConnect: options => tls.connect(options)
};

function loadEmailSettingsFile() {
  const file = path.join(__dirname, "..", "email-settings.env");
  if (!fs.existsSync(file)) return {};
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .reduce((settings, line) => {
      const index = line.indexOf("=");
      if (index === -1) return settings;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      settings[key] = value;
      return settings;
    }, {});
}

function setting(fileSettings, key, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
  return fileSettings[key] || fallback;
}

function emailConfig() {
  const fileSettings = loadEmailSettingsFile();
  const provider = setting(fileSettings, "EMAIL_PROVIDER", "auto").toLowerCase();
  const resendApiKey = setting(fileSettings, "RESEND_API_KEY");
  const effectiveProvider = provider === "resend" || (provider === "auto" && resendApiKey) ? "resend" : provider;
  const port = Number(setting(fileSettings, "SMTP_PORT", 465));
  const timeoutMs = Number(setting(fileSettings, "SMTP_TIMEOUT_MS", 15000));
  const smtpFrom = setting(fileSettings, "SMTP_FROM", setting(fileSettings, "SMTP_USER"));
  const resendFrom = setting(fileSettings, "RESEND_FROM", smtpFrom);
  const smtpFromName = setting(fileSettings, "SMTP_FROM_NAME", "CallCatch");
  const resendFromName = setting(fileSettings, "RESEND_FROM_NAME", smtpFromName);
  const smtpReplyTo = setting(fileSettings, "SMTP_REPLY_TO", smtpFrom);
  const resendReplyTo = setting(fileSettings, "RESEND_REPLY_TO", smtpReplyTo);
  return {
    provider,
    resendApiKey,
    resendFrom,
    resendFromName,
    resendReplyTo,
    brevoApiKey: setting(fileSettings, "BREVO_API_KEY"),
    host: setting(fileSettings, "SMTP_HOST"),
    port: Number.isFinite(port) && port > 0 ? port : 465,
    secure: parseBoolean(setting(fileSettings, "SMTP_SECURE", "true"), true),
    user: setting(fileSettings, "SMTP_USER"),
    pass: setting(fileSettings, "SMTP_PASS"),
    from: effectiveProvider === "resend" ? resendFrom : smtpFrom,
    fromName: effectiveProvider === "resend" ? resendFromName : smtpFromName,
    replyTo: effectiveProvider === "resend" ? resendReplyTo : smtpReplyTo,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
    source: Object.keys(fileSettings).length ? "email-settings.env" : "environment"
  };
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(text)) return true;
  if (["false", "0", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function configured(config = emailConfig()) {
  if (config.provider === "resend") return Boolean(config.resendApiKey && parseEmail(config.from));
  if (config.provider === "brevo") return Boolean(config.brevoApiKey && config.from);
  if (config.provider === "smtp") return Boolean(config.host && config.port && config.user && config.pass && config.from);
  return Boolean((config.resendApiKey || config.brevoApiKey || (config.host && config.port && config.user && config.pass)) && parseEmail(config.from));
}

function encodeBase64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function escapeData(value) {
  return String(value || "").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function parseEmail(value) {
  const text = String(value || "").trim();
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function emailDomain(value) {
  const email = parseEmail(value);
  return email.includes("@") ? email.split("@").pop().toLowerCase() : "";
}

function maskEmail(value) {
  const email = parseEmail(value);
  if (!email) return "";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

function smtpResponseCode(error) {
  if (error?.responseCode) return error.responseCode;
  const match = String(error?.message || error || "").match(/\b([245]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function sanitizeMessage(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bre_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, "[redacted]")
    .replace(/(pass(word)?|api[-_ ]?key|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function errorCauses(error, seen = new Set()) {
  if (!error || seen.has(error)) return [];
  seen.add(error);
  const nested = [];
  if (Array.isArray(error.errors)) nested.push(...error.errors);
  if (error.cause) nested.push(error.cause);
  for (const item of nested) {
    nested.push(...errorCauses(item, seen));
  }
  return nested.filter(Boolean);
}

function sanitizedErrorDetails(error) {
  return {
    name: error?.name || "Error",
    message: sanitizeMessage(error?.message || error),
    code: error?.code || "",
    errno: error?.errno || "",
    syscall: error?.syscall || "",
    hostname: error?.hostname || error?.host || "",
    address: error?.address || "",
    port: error?.port || "",
    command: error?.smtpCommand || error?.command || "",
    responseCode: smtpResponseCode(error) || ""
  };
}

function sanitizeEmailError(error) {
  const details = sanitizedErrorDetails(error);
  const causes = errorCauses(error).map(sanitizedErrorDetails);
  return {
    name: details.name || "EmailError",
    message: details.message || "Email send failed",
    code: details.code,
    errno: details.errno,
    syscall: details.syscall,
    hostname: details.hostname,
    address: details.address,
    port: details.port,
    command: details.command,
    responseCode: details.responseCode || undefined,
    causes
  };
}

function safeEmailMeta({ config = emailConfig(), recipient = "", route = "", task = {} } = {}) {
  return {
    provider: activeProvider(config),
    host: config.host || "",
    port: config.port || "",
    secure: !!config.secure,
    fromDomain: emailDomain(config.from),
    recipientDomain: emailDomain(recipient),
    route,
    taskId: task?.id || "",
    leadId: task?.leadId || ""
  };
}

function logEmail(level, message, meta = {}) {
  try {
    emailLogger({
      time: new Date().toISOString(),
      level,
      message,
      ...meta
    });
  } catch {}
}

function formatAddress(email, name = "") {
  const address = parseEmail(email);
  const displayName = String(name || "").trim().replace(/["\r\n]/g, "");
  if (!address || !displayName) return address;
  return `"${displayName}" <${address}>`;
}

function splitSubjectBody(body) {
  const text = String(body || "");
  const lines = text.split(/\r?\n/);
  const first = lines[0] || "";
  if (/^subject:/i.test(first)) {
    return {
      subject: first.replace(/^subject:\s*/i, "").trim() || "CallCatch follow-up",
      body: lines.slice(1).join("\n").trim()
    };
  }
  return {
    subject: "CallCatch follow-up",
    body: text
  };
}

function activeProvider(config = emailConfig()) {
  if (config.provider === "resend" || (config.provider === "auto" && config.resendApiKey)) return "resend";
  if (config.provider === "brevo" || (config.provider === "auto" && config.brevoApiKey)) return "brevo";
  if (config.provider === "smtp" || (config.host && config.user && config.pass)) return "smtp";
  return "not-configured";
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Email API timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function plainTextToHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
}

function smtpSocketOptions(config, family) {
  const options = {
    host: config.host,
    port: config.port
  };
  if (family) options.family = family;
  if (config.secure) options.servername = config.host;
  return options;
}

function connectSmtpSocket(config, family) {
  const options = smtpSocketOptions(config, family);
  return config.secure
    ? smtpSocketConnectors.tlsConnect(options)
    : smtpSocketConnectors.netConnect(options);
}

function shouldRetryIpv4(config, error, retried) {
  if (retried) return false;
  if (!/smtp\.gmail\.com$/i.test(String(config.host || ""))) return false;
  const details = [sanitizedErrorDetails(error), ...errorCauses(error).map(sanitizedErrorDetails)];
  return details.some(item =>
    item.name === "AggregateError"
    || item.code === "ENETUNREACH"
    || item.code === "EHOSTUNREACH"
    || (item.address && String(item.address).includes(":"))
  );
}

function smtpClient(config) {
  const timeoutMs = Number(config.timeoutMs || 15000);
  let socket = connectSmtpSocket(config);
  let retriedIpv4 = false;

  let buffer = "";
  function applyTimeout() {
    socket.setTimeout(timeoutMs);
  }
  applyTimeout();

  async function retryIpv4After(error) {
    retriedIpv4 = true;
    try {
      socket.destroy();
    } catch {}
    socket = connectSmtpSocket(config, 4);
    buffer = "";
    applyTimeout();
    logEmail("warn", "smtp_ipv4_fallback_started", {
      provider: "smtp",
      host: config.host || "",
      port: config.port || "",
      secure: !!config.secure,
      error: sanitizeEmailError(error)
    });
  }

  function readResponse() {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
      };
      const onError = error => {
        cleanup();
        if (shouldRetryIpv4(config, error, retriedIpv4)) {
          retryIpv4After(error)
            .then(() => readResponse().then(resolve, reject))
            .catch(reject);
          return;
        }
        reject(error);
      };
      const onTimeout = () => {
        cleanup();
        socket.destroy();
        reject(new Error(`SMTP timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      };
      const onData = chunk => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1] || "";
        if (/^\d{3}\s/.test(last)) {
          cleanup();
          const response = buffer;
          buffer = "";
          resolve(response);
        }
      };
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
    });
  }

  async function command(line, expected, label = line) {
    socket.write(`${line}\r\n`);
    const response = await readResponse();
    if (expected && !expected.some(code => response.startsWith(code))) {
      const error = new Error(`SMTP command failed at ${label}: ${response.trim()}`);
      error.smtpCommand = label;
      error.responseCode = Number(response.slice(0, 3)) || undefined;
      throw error;
    }
    return response;
  }

  async function startTls() {
    await command("STARTTLS", ["220"], "STARTTLS");
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("timeout");
    socket = smtpSocketConnectors.tlsConnect({ socket, servername: config.host });
    buffer = "";
    applyTimeout();
    await new Promise((resolve, reject) => {
      const onSecure = () => {
        cleanup();
        resolve();
      };
      const onError = error => {
        cleanup();
        reject(error);
      };
      const onTimeout = () => {
        cleanup();
        socket.destroy();
        reject(new Error(`SMTP STARTTLS timed out after ${Math.round(timeoutMs / 1000)} seconds`));
      };
      const cleanup = () => {
        socket.off("secureConnect", onSecure);
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
      };
      socket.once("secureConnect", onSecure);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
    });
  }

  return {
    get socket() {
      return socket;
    },
    readResponse,
    command,
    startTls
  };
}

async function sendViaResend({ recipient, subject, body, lead, task, config }) {
  if (!config.resendApiKey) throw new Error("RESEND_API_KEY is not configured");
  if (!parseEmail(config.from)) throw new Error("RESEND_FROM is not configured");
  if (config.replyTo && !parseEmail(config.replyTo)) throw new Error("RESEND_REPLY_TO is not a valid email address");
  const response = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: formatAddress(config.from, config.fromName),
      to: [recipient],
      reply_to: config.replyTo ? formatAddress(config.replyTo, config.fromName) : undefined,
      subject,
      text: body,
      tags: [
        { name: "source", value: "callcatch" },
        { name: "lead_id", value: String(lead?.id || task?.leadId || "unknown").slice(0, 256) },
        { name: "task_id", value: String(task?.id || "unknown").slice(0, 256) }
      ]
    })
  }, config.timeoutMs);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Resend API failed with ${response.status}`);
    error.responseCode = response.status;
    error.code = "RESEND_API_ERROR";
    throw error;
  }
  return {
    ok: true,
    provider: "Resend",
    to: recipient,
    subject,
    messageId: payload.id || `<resend-${Date.now()}@callcatch>`,
    sentAt: new Date().toISOString()
  };
}

async function sendViaBrevo({ recipient, subject, body, lead, task, config }) {
  if (!config.brevoApiKey) throw new Error("BREVO_API_KEY is not configured");
  const response = await fetchWithTimeout("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": config.brevoApiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sender: { name: config.fromName || "CallCatch", email: parseEmail(config.from) },
      to: [{ email: recipient, name: lead?.business || "" }],
      replyTo: config.replyTo ? { name: config.fromName || "CallCatch", email: parseEmail(config.replyTo) } : undefined,
      subject,
      textContent: body,
      htmlContent: plainTextToHtml(body),
      tags: ["callcatch", String(lead?.trade || "prospect").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 50)]
    })
  }, config.timeoutMs);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Brevo API failed with ${response.status}`);
  }
  return {
    ok: true,
    provider: "Brevo",
    to: recipient,
    subject,
    messageId: payload.messageId || `<brevo-${Date.now()}@callcatch>`,
    sentAt: new Date().toISOString()
  };
}

async function sendViaSmtp({ recipient, subject, body, config }) {
  if (!(config.host && config.port && config.user && config.pass && config.from)) {
    throw new Error("SMTP is not configured");
  }
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@callcatch.local>`;
  const message = [
    `From: ${formatAddress(config.from, config.fromName)}`,
    `To: ${recipient}`,
    `Reply-To: ${formatAddress(config.replyTo, config.fromName)}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ].join("\r\n");

  const client = smtpClientFactory(config);
  try {
    await client.readResponse();
    let ehlo = await client.command(`EHLO callcatch.local`, ["250"], "EHLO");
    if (!config.secure && /STARTTLS/i.test(ehlo) && client.startTls) {
      await client.startTls();
      ehlo = await client.command(`EHLO callcatch.local`, ["250"], "EHLO_AFTER_STARTTLS");
    }
    await client.command("AUTH LOGIN", ["334"], "AUTH_LOGIN");
    await client.command(encodeBase64(config.user), ["334"], "AUTH_USERNAME");
    await client.command(encodeBase64(config.pass), ["235"], "AUTH_PASSWORD");
    await client.command(`MAIL FROM:<${parseEmail(config.from)}>`, ["250"], "MAIL_FROM");
    await client.command(`RCPT TO:<${recipient}>`, ["250", "251"], "RCPT_TO");
    await client.command("DATA", ["354"], "DATA");
    client.socket.write(`${escapeData(message)}\r\n.\r\n`);
    const dataResponse = await client.readResponse();
    if (!dataResponse.startsWith("250")) {
      throw new Error(`SMTP DATA failed: ${dataResponse.trim()}`);
    }
    await client.command("QUIT", ["221"]);
    return {
      ok: true,
      provider: "SMTP",
      to: recipient,
      subject,
      messageId,
      sentAt: new Date().toISOString()
    };
  } finally {
    client.socket.end();
  }
}

async function verifyEmailTransport(config = emailConfig()) {
  if (!configured(config)) {
    throw new Error("Email provider is not configured");
  }
  const provider = activeProvider(config);
  if (provider === "resend") {
    if (!config.resendApiKey) throw new Error("RESEND_API_KEY is not configured");
    if (!parseEmail(config.from)) throw new Error("RESEND_FROM is not a valid email address");
    if (config.replyTo && !parseEmail(config.replyTo)) throw new Error("RESEND_REPLY_TO is not a valid email address");
    return {
      ok: true,
      provider,
      verified: true,
      mode: "configuration-only",
      fromDomain: emailDomain(config.from),
      replyToDomain: emailDomain(config.replyTo)
    };
  }
  if (provider !== "smtp") {
    return { ok: true, provider, verified: true, mode: "api-configured" };
  }
  const client = smtpClientFactory(config);
  try {
    await client.readResponse();
    let ehlo = await client.command("EHLO callcatch.local", ["250"], "EHLO");
    if (!config.secure && /STARTTLS/i.test(ehlo) && client.startTls) {
      await client.startTls();
      ehlo = await client.command("EHLO callcatch.local", ["250"], "EHLO_AFTER_STARTTLS");
    }
    await client.command("AUTH LOGIN", ["334"], "AUTH_LOGIN");
    await client.command(encodeBase64(config.user), ["334"], "AUTH_USERNAME");
    await client.command(encodeBase64(config.pass), ["235"], "AUTH_PASSWORD");
    await client.command("QUIT", ["221"], "QUIT");
    return { ok: true, provider, verified: true };
  } finally {
    client.socket.end();
  }
}

async function sendEmail({ to, subject, body, lead, task }, config = emailConfig()) {
  if (!configured(config)) {
    throw new Error("Email provider is not configured");
  }

  const recipient = parseEmail(to || lead?.email || task?.to || task?.recipient);
  if (!recipient) {
    throw new Error("No recipient email found");
  }

  const parsed = splitSubjectBody(body || task?.body || "");
  const finalSubject = subject || parsed.subject;
  const finalBody = parsed.body || body || task?.body || "";

  const provider = activeProvider(config);
  const meta = safeEmailMeta({ config, recipient, route: "sendEmail", task });
  logEmail("info", "email_send_started", meta);
  try {
    let result;
    if (provider === "resend") result = await sendViaResend({ recipient, subject: finalSubject, body: finalBody, lead, task, config });
    else if (provider === "brevo") result = await sendViaBrevo({ recipient, subject: finalSubject, body: finalBody, lead, task, config });
    else if (provider === "smtp") result = await sendViaSmtp({ recipient, subject: finalSubject, body: finalBody, config });
    else throw new Error("Email provider is not configured");
    logEmail("info", "email_send_succeeded", { ...meta, provider: result.provider || provider, messageId: result.messageId || "" });
    return result;
  } catch (error) {
    const safe = sanitizeEmailError(error);
    logEmail("error", "email_send_failed", { ...meta, error: safe });
    const publicError = new Error(safe.message);
    publicError.publicMessage = safe.message;
    publicError.code = safe.code;
    publicError.responseCode = safe.responseCode;
    publicError.smtpCommand = safe.command;
    publicError.causes = safe.causes;
    throw publicError;
  }
}

module.exports = {
  __setEmailLoggerForTests(logger) {
    emailLogger = logger || (() => {});
  },
  __setSmtpClientFactoryForTests(factory) {
    smtpClientFactory = factory || smtpClient;
  },
  __setSmtpSocketConnectorsForTests(connectors) {
    smtpSocketConnectors = connectors || {
      netConnect: options => net.connect(options),
      tlsConnect: options => tls.connect(options)
    };
  },
  activeProvider,
  configured,
  emailConfig,
  formatAddress,
  maskEmail,
  parseEmail,
  parseBoolean,
  sanitizeEmailError,
  sanitizedErrorDetails,
  sendEmail,
  verifyEmailTransport
};
