
const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "whatsapp.sqlite"));

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS wa_users (
    jid TEXT PRIMARY KEY,
    name TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wa_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    amount INTEGER NOT NULL,
    qris_sent INTEGER NOT NULL DEFAULT 0,
    proof_image TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    approved_at TEXT
  );
`);

module.exports = db;
