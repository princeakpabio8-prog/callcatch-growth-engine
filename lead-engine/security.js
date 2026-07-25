const crypto = require("crypto");
const { isProduction } = require("./runtimeConfig");

const PUBLIC_ROUTES = new Set([
  "GET /health",
  "GET /",
  "GET /dashboard",
  "GET /callcatch-lead-dashboard.html"
]);

const ADMIN_ROUTES = new Set([
  "GET /api/audit-log",
  "GET /api/export/json",
  "GET /api/email/verify",
  "POST /api/recovery/resend-sent",
  "POST /api/sending/settings"
]);

const WEBHOOK_ROUTES = new Set([
  "POST /api/webhooks/resend/inbound"
]);

function splitList(value = "") {
  return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

function securityConfig(env = process.env) {
  return {
    operatorToken: String(env.CALLCATCH_OPERATOR_TOKEN || "").trim(),
    adminToken: String(env.CALLCATCH_ADMIN_TOKEN || "").trim(),
    allowedOrigins: splitList(env.CALLCATCH_ALLOWED_ORIGINS),
    webhookSecret: String(env.RESEND_WEBHOOK_SECRET || "").trim(),
    production: isProduction(env)
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(headers = {}) {
  const header = String(headers.authorization || headers.Authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : String(headers["x-callcatch-token"] || "").trim();
}

function routeAccess(method = "GET", pathname = "/") {
  const key = `${String(method).toUpperCase()} ${pathname}`;
  if (PUBLIC_ROUTES.has(key)) return "public";
  if (WEBHOOK_ROUTES.has(key)) return "webhook";
  if (ADMIN_ROUTES.has(key)) return "admin";
  if (pathname.startsWith("/api/")) return "operator";
  return "public";
}

function authenticate(headers = {}, requiredRole = "operator", env = process.env) {
  if (requiredRole === "public" || requiredRole === "webhook") return { ok: true, role: requiredRole };
  const config = securityConfig(env);
  if (!config.production && !config.operatorToken && !config.adminToken) {
    return { ok: true, role: "admin", developmentBypass: true };
  }
  const token = bearerToken(headers);
  if (safeEqual(token, config.adminToken)) return { ok: true, role: "admin" };
  if (requiredRole !== "admin" && safeEqual(token, config.operatorToken)) return { ok: true, role: "operator" };
  return { ok: false, role: "none", requiredRole };
}

function originAllowed(origin = "", env = process.env) {
  if (!origin) return true;
  const config = securityConfig(env);
  if (!config.production && config.allowedOrigins.length === 0) {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin) || origin === "null";
  }
  return config.allowedOrigins.includes(origin);
}

function assertProductionSecurityReady(env = process.env) {
  const config = securityConfig(env);
  if (!config.production) return config;
  const errors = [];
  if (config.operatorToken.length < 24) errors.push("CALLCATCH_OPERATOR_TOKEN must contain at least 24 characters");
  if (config.adminToken.length < 24) errors.push("CALLCATCH_ADMIN_TOKEN must contain at least 24 characters");
  if (config.operatorToken && safeEqual(config.operatorToken, config.adminToken)) errors.push("Operator and admin tokens must be different");
  if (config.allowedOrigins.length === 0) errors.push("CALLCATCH_ALLOWED_ORIGINS must list at least one approved frontend origin");
  const provider = String(env.EMAIL_PROVIDER || "").toLowerCase();
  if ((provider === "resend" || (provider === "auto" && env.RESEND_API_KEY)) && config.webhookSecret.length < 16) {
    errors.push("RESEND_WEBHOOK_SECRET is required for signed Resend events");
  }
  if (errors.length) {
    const error = new Error(`Production security configuration is incomplete: ${errors.join("; ")}`);
    error.code = "SECURITY_CONFIGURATION_INVALID";
    throw error;
  }
  return config;
}

function webhookSigningKey(secret = "") {
  const value = String(secret || "").trim();
  if (!value) return Buffer.alloc(0);
  const encoded = value.startsWith("whsec_") ? value.slice(6) : value;
  try {
    return Buffer.from(encoded, "base64");
  } catch {
    return Buffer.from(encoded);
  }
}

function header(headers = {}, name) {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function verifyResendWebhook({ rawBody = "", headers = {}, secret = "", now = Date.now(), toleranceSeconds = 300 } = {}) {
  const messageId = header(headers, "svix-id") || header(headers, "webhook-id");
  const timestamp = header(headers, "svix-timestamp") || header(headers, "webhook-timestamp");
  const signatureHeader = header(headers, "svix-signature") || header(headers, "webhook-signature");
  const numericTimestamp = Number(timestamp);
  if (!secret) return { ok: false, code: "WEBHOOK_SECRET_MISSING" };
  if (!messageId || !numericTimestamp || !signatureHeader) return { ok: false, code: "WEBHOOK_SIGNATURE_MISSING" };
  if (Math.abs(Math.floor(now / 1000) - numericTimestamp) > toleranceSeconds) return { ok: false, code: "WEBHOOK_TIMESTAMP_INVALID" };
  const key = webhookSigningKey(secret);
  if (!key.length) return { ok: false, code: "WEBHOOK_SECRET_INVALID" };
  const signedPayload = `${messageId}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", key).update(signedPayload).digest("base64");
  const candidates = signatureHeader.split(/\s+/).map(item => item.trim()).filter(Boolean).map(item => {
    if (item.startsWith("v1,")) return item.slice(3);
    if (item.startsWith("v1=")) return item.slice(3);
    return "";
  }).filter(Boolean);
  const ok = candidates.some(candidate => safeEqual(candidate, expected));
  return { ok, code: ok ? "WEBHOOK_VERIFIED" : "WEBHOOK_SIGNATURE_INVALID", messageId };
}

module.exports = {
  assertProductionSecurityReady,
  authenticate,
  bearerToken,
  originAllowed,
  routeAccess,
  safeEqual,
  securityConfig,
  verifyResendWebhook
};
