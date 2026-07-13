const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "callcatch-crm.json");
const STATE_ID = "main";

const initialState = {
  leads: [],
  campaigns: [],
  approvalQueue: [],
  savedSearches: [],
  auditLog: [],
  jobs: [],
  brainOneRuns: [],
  brainTwoRuns: [],
  brainZeroRuns: []
};

let writeQueue = Promise.resolve();
let poolPromise = null;
let postgresUnavailableReason = "";

function databaseUrl() {
  return String(process.env.DATABASE_URL || "").trim();
}

function sslConfig() {
  if (!process.env.RENDER && !/sslmode=require/i.test(databaseUrl())) return false;
  return { rejectUnauthorized: false };
}

async function getPool() {
  if (!databaseUrl()) return null;
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    let Pool;
    try {
      ({ Pool } = require("pg"));
    } catch (error) {
      postgresUnavailableReason = "pg dependency is not installed";
      return null;
    }
    const pool = new Pool({
      connectionString: databaseUrl(),
      ssl: sslConfig()
    });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS callcatch_state (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      return pool;
    } catch (error) {
      postgresUnavailableReason = error.message;
      try {
        await pool.end();
      } catch {}
      return null;
    }
  })();
  return poolPromise;
}

function normalizeState(state = {}) {
  return { ...initialState, ...state };
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify(initialState, null, 2));
  }
}

async function readStore() {
  const pool = await getPool();
  if (pool) {
    const result = await pool.query("SELECT data FROM callcatch_state WHERE id = $1", [STATE_ID]);
    if (!result.rows.length) {
      await pool.query(
        "INSERT INTO callcatch_state (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
        [STATE_ID, JSON.stringify(initialState)]
      );
      return normalizeState(initialState);
    }
    return normalizeState(result.rows[0].data || {});
  }
  await ensureStore();
  const raw = await fs.readFile(DB_FILE, "utf8");
  return normalizeState(JSON.parse(raw || "{}"));
}

async function writeStore(state) {
  const nextState = normalizeState(state);
  const pool = await getPool();
  if (pool) {
    writeQueue = writeQueue.then(() => pool.query(
      "INSERT INTO callcatch_state (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
      [STATE_ID, JSON.stringify(nextState)]
    ));
    await writeQueue;
    return;
  }
  await ensureStore();
  writeQueue = writeQueue.then(() => fs.writeFile(DB_FILE, JSON.stringify(nextState, null, 2)));
  await writeQueue;
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function mutateStore(mutator) {
  const state = await readStore();
  const result = await mutator(state);
  await writeStore(state);
  return result;
}

async function audit(action, details = {}) {
  return mutateStore(state => {
    const entry = {
      id: newId("audit"),
      at: new Date().toISOString(),
      action,
      details
    };
    state.auditLog.unshift(entry);
    state.auditLog = state.auditLog.slice(0, 2000);
    return entry;
  });
}

function storageMode() {
  if (databaseUrl() && !postgresUnavailableReason) return "postgres";
  if (databaseUrl() && postgresUnavailableReason) return `json-file-fallback (${postgresUnavailableReason})`;
  return "json-file";
}

module.exports = {
  audit,
  mutateStore,
  newId,
  readStore,
  storageMode,
  writeStore
};
