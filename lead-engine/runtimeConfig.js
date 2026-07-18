function isProduction(env = process.env) {
  return String(env.NODE_ENV || "").toLowerCase() === "production";
}

function isCloudRuntime(env = process.env) {
  return isProduction(env) || Boolean(env.RENDER || env.RAILWAY_ENVIRONMENT);
}

function resolveHost(env = process.env) {
  if (env.HOST) return env.HOST;
  return isCloudRuntime(env) ? "0.0.0.0" : "127.0.0.1";
}

function resolvePort(env = process.env) {
  return Number(env.PORT || 8787);
}

module.exports = {
  isCloudRuntime,
  isProduction,
  resolveHost,
  resolvePort
};
