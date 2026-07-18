const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { resolveHost } = require("../lead-engine/runtimeConfig");
const { emailConfig, configured: emailConfigured } = require("../lead-engine/emailAdapter");
const dataStore = require("../lead-engine/dataStore");

const repoRoot = path.join(__dirname, "..");

function withEnv(nextEnv, fn) {
  const previous = {};
  for (const key of Object.keys(nextEnv)) {
    previous[key] = process.env[key];
    if (nextEnv[key] === undefined) delete process.env[key];
    else process.env[key] = nextEnv[key];
  }
  try {
    dataStore.__resetForTests();
    return fn();
  } finally {
    for (const key of Object.keys(nextEnv)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    dataStore.__resetForTests();
  }
}

test("production startup fails when DATABASE_URL is missing", () => {
  const child = spawnSync(process.execPath, ["callcatch-lead-server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: "",
      HOST: "127.0.0.1",
      PORT: "0"
    },
    encoding: "utf8",
    timeout: 8000
  });
  assert.equal(child.status, 1);
  assert.match(`${child.stdout}\n${child.stderr}`, /production_storage_startup_failed/);
  assert.match(`${child.stdout}\n${child.stderr}`, /DATABASE_URL is required/);
});

test("local development can still use JSON fallback", async () => {
  await withEnv({ NODE_ENV: "development", DATABASE_URL: undefined }, async () => {
    const status = await dataStore.assertProductionStorageReady();
    assert.deepEqual(status, { provider: "json", connected: true, error: "" });
  });
});

test("health storage payload identifies PostgreSQL storage", () => {
  withEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://user:pass@example.test:5432/callcatch" }, () => {
    const status = dataStore.storageStatus();
    assert.equal(status.provider, "postgres");
    assert.equal(status.connected, true);
  });
});

test("health storage payload identifies JSON fallback during local testing", () => {
  withEnv({ NODE_ENV: "test", DATABASE_URL: undefined }, () => {
    const status = dataStore.storageStatus();
    assert.deepEqual(status, { provider: "json", connected: true, error: "" });
  });
});

test("production host defaults to 0.0.0.0", () => {
  assert.equal(resolveHost({ NODE_ENV: "production" }), "0.0.0.0");
});

test("Railway and Render cloud runtimes default to 0.0.0.0", () => {
  assert.equal(resolveHost({ RAILWAY_ENVIRONMENT: "production" }), "0.0.0.0");
  assert.equal(resolveHost({ RENDER: "true" }), "0.0.0.0");
});

test("explicit HOST overrides production and local defaults", () => {
  assert.equal(resolveHost({ NODE_ENV: "production", HOST: "127.0.0.1" }), "127.0.0.1");
  assert.equal(resolveHost({ NODE_ENV: "development", HOST: "0.0.0.0" }), "0.0.0.0");
});

test("local host defaults to 127.0.0.1", () => {
  assert.equal(resolveHost({ NODE_ENV: "development" }), "127.0.0.1");
  assert.equal(resolveHost({}), "127.0.0.1");
});

test("Gmail SMTP configuration uses existing email adapter without sending", () => {
  withEnv({
    EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "prince@example.com",
    SMTP_PASS: "google-app-password-placeholder",
    SMTP_FROM: "prince@example.com",
    SMTP_FROM_NAME: "Prince Akpabio | CallCatch",
    SMTP_REPLY_TO: "prince@example.com"
  }, () => {
    const config = emailConfig();
    assert.equal(config.provider, "smtp");
    assert.equal(config.host, "smtp.gmail.com");
    assert.equal(config.fromName, "Prince Akpabio | CallCatch");
    assert.equal(emailConfigured(config), true);
  });
});
