const fs = require("fs");
const path = require("path");

function loadSettingsFile() {
  const file = path.join(__dirname, "..", "email-settings.env");
  if (!fs.existsSync(file)) return {};
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .reduce((settings, line) => {
      const index = line.indexOf("=");
      if (index === -1) return settings;
      settings[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      return settings;
    }, {});
}

function setting(fileSettings, key, fallback = "") {
  return process.env[key] || fileSettings[key] || fallback;
}

function smsConfig() {
  const fileSettings = loadSettingsFile();
  return {
    provider: setting(fileSettings, "SMS_PROVIDER", "twilio").toLowerCase(),
    accountSid: setting(fileSettings, "TWILIO_ACCOUNT_SID"),
    authToken: setting(fileSettings, "TWILIO_AUTH_TOKEN"),
    fromNumber: setting(fileSettings, "TWILIO_FROM_NUMBER"),
    timeoutMs: Number(setting(fileSettings, "TWILIO_TIMEOUT_MS", 15000)),
    source: Object.keys(fileSettings).length ? "email-settings.env" : "environment"
  };
}

function configured(config = smsConfig()) {
  return config.provider === "twilio" && Boolean(config.accountSid && config.authToken && config.fromNumber);
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return raw.replace(/[^\d+]/g, "");
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Twilio timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sendSms({ to, body, lead, task }, config = smsConfig()) {
  if (!configured(config)) throw new Error("Twilio SMS is not configured");
  const recipient = normalizePhone(to || task?.to || task?.recipient || lead?.phone);
  if (!recipient) throw new Error("No recipient phone number found");

  const message = String(body || task?.body || "").trim();
  if (!message) throw new Error("SMS body is empty");
  if (message.length > 1500) throw new Error("SMS body is too long");

  const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  const form = new URLSearchParams({
    From: normalizePhone(config.fromNumber),
    To: recipient,
    Body: message
  });
  const response = await fetchWithTimeout(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  }, config.timeoutMs);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error_message || `Twilio API failed with ${response.status}`);
  }
  return {
    ok: true,
    provider: "Twilio",
    to: recipient,
    messageId: payload.sid || `twilio-${Date.now()}`,
    sentAt: new Date().toISOString(),
    status: payload.status || "queued"
  };
}

module.exports = {
  configured,
  normalizePhone,
  sendSms,
  smsConfig
};
