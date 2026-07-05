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
    messagingServiceSid: setting(fileSettings, "TWILIO_MESSAGING_SERVICE_SID"),
    timeoutMs: Number(setting(fileSettings, "TWILIO_TIMEOUT_MS", 15000)),
    source: Object.keys(fileSettings).length ? "email-settings.env" : "environment"
  };
}

function configured(config = smsConfig()) {
  return config.provider === "twilio" && Boolean(config.accountSid && config.authToken && (config.fromNumber || config.messagingServiceSid));
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

function twilioHelp(payload = {}) {
  const code = String(payload.code || "");
  const message = payload.message || payload.error_message || "";
  const fixes = {
    21211: "The recipient phone number is invalid. Use full E.164 format, for example +12145550123.",
    21408: "Twilio is not allowed to send SMS to that country yet. Enable the country in Messaging Geographic Permissions.",
    21606: "Your Twilio From number is not SMS-capable or is not valid for outbound SMS. Use an SMS-enabled Twilio number or a Messaging Service SID.",
    21608: "This looks like a Twilio trial restriction. Verify the recipient phone number in Twilio, or upgrade the Twilio account before texting unverified prospects.",
    21610: "That recipient has opted out. Do not text this number unless they opt back in.",
    21612: "Twilio cannot route SMS from your sender to that recipient. Use an SMS-capable sender for that destination.",
    21614: "The recipient number is not a mobile/SMS-capable number.",
    30007: "The carrier filtered this SMS. Use compliant opt-in messaging and a registered sender."
  };
  const fix = fixes[code] || "Check the Twilio error code, sender number, recipient format, account balance, and geographic permissions.";
  return [
    message || `Twilio API failed${code ? ` with code ${code}` : ""}`,
    fix,
    payload.more_info ? `More info: ${payload.more_info}` : ""
  ].filter(Boolean).join(" ");
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
    To: recipient,
    Body: message
  });
  if (config.messagingServiceSid) form.set("MessagingServiceSid", config.messagingServiceSid);
  else form.set("From", normalizePhone(config.fromNumber));
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
    throw new Error(twilioHelp({ ...payload, status: response.status }));
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
