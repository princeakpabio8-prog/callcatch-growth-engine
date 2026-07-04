const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

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
  return process.env[key] || fileSettings[key] || fallback;
}

function emailConfig() {
  const fileSettings = loadEmailSettingsFile();
  return {
    host: setting(fileSettings, "SMTP_HOST"),
    port: Number(setting(fileSettings, "SMTP_PORT", 465)),
    secure: String(setting(fileSettings, "SMTP_SECURE", "true")).toLowerCase() !== "false",
    user: setting(fileSettings, "SMTP_USER"),
    pass: setting(fileSettings, "SMTP_PASS"),
    from: setting(fileSettings, "SMTP_FROM", setting(fileSettings, "SMTP_USER")),
    fromName: setting(fileSettings, "SMTP_FROM_NAME", "CallCatch"),
    replyTo: setting(fileSettings, "SMTP_REPLY_TO", setting(fileSettings, "SMTP_FROM", setting(fileSettings, "SMTP_USER"))),
    timeoutMs: Number(setting(fileSettings, "SMTP_TIMEOUT_MS", 15000)),
    source: Object.keys(fileSettings).length ? "email-settings.env" : "environment"
  };
}

function configured(config = emailConfig()) {
  return Boolean(config.host && config.port && config.user && config.pass && config.from);
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

function smtpClient(config) {
  const timeoutMs = Number(config.timeoutMs || 15000);
  const socket = config.secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host })
    : net.connect({ host: config.host, port: config.port });

  let buffer = "";
  socket.setTimeout(timeoutMs);

  function readResponse() {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
      };
      const onError = error => {
        cleanup();
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

  async function command(line, expected) {
    socket.write(`${line}\r\n`);
    const response = await readResponse();
    if (expected && !expected.some(code => response.startsWith(code))) {
      throw new Error(`SMTP command failed: ${line} -> ${response.trim()}`);
    }
    return response;
  }

  return { socket, readResponse, command };
}

async function sendEmail({ to, subject, body, lead, task }, config = emailConfig()) {
  if (!configured(config)) {
    throw new Error("SMTP is not configured");
  }

  const recipient = parseEmail(to || lead?.email || task?.to || task?.recipient);
  if (!recipient) {
    throw new Error("No recipient email found");
  }

  const parsed = splitSubjectBody(body || task?.body || "");
  const finalSubject = subject || parsed.subject;
  const finalBody = parsed.body || body || task?.body || "";
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@callcatch.local>`;
  const message = [
    `From: ${formatAddress(config.from, config.fromName)}`,
    `To: ${recipient}`,
    `Reply-To: ${formatAddress(config.replyTo, config.fromName)}`,
    `Subject: ${finalSubject}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    finalBody
  ].join("\r\n");

  const client = smtpClient(config);
  try {
    await client.readResponse();
    await client.command(`EHLO callcatch.local`, ["250"]);
    await client.command("AUTH LOGIN", ["334"]);
    await client.command(encodeBase64(config.user), ["334"]);
    await client.command(encodeBase64(config.pass), ["235"]);
    await client.command(`MAIL FROM:<${parseEmail(config.from)}>`, ["250"]);
    await client.command(`RCPT TO:<${recipient}>`, ["250", "251"]);
    await client.command("DATA", ["354"]);
    client.socket.write(`${escapeData(message)}\r\n.\r\n`);
    const dataResponse = await client.readResponse();
    if (!dataResponse.startsWith("250")) {
      throw new Error(`SMTP DATA failed: ${dataResponse.trim()}`);
    }
    await client.command("QUIT", ["221"]);
    return {
      ok: true,
      to: recipient,
      subject: finalSubject,
      messageId,
      sentAt: new Date().toISOString()
    };
  } finally {
    client.socket.end();
  }
}

module.exports = {
  configured,
  emailConfig,
  formatAddress,
  parseEmail,
  sendEmail
};
