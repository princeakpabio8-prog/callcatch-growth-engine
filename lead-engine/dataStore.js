const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "callcatch-crm.json");

const initialState = {
  leads: [],
  campaigns: [],
  approvalQueue: [],
  savedSearches: [],
  auditLog: [],
  jobs: []
};

let writeQueue = Promise.resolve();

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify(initialState, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(DB_FILE, "utf8");
  return { ...initialState, ...JSON.parse(raw || "{}") };
}

async function writeStore(state) {
  await ensureStore();
  writeQueue = writeQueue.then(() => fs.writeFile(DB_FILE, JSON.stringify({ ...initialState, ...state }, null, 2)));
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

module.exports = {
  audit,
  mutateStore,
  newId,
  readStore,
  writeStore
};
