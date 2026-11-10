import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

// Hand-written idempotent DDL, executed at startup. The schema settled
// (tool_pins, approvals, audit_events, run_tags) without ever needing
// formal drizzle-kit migrations in practice — this file has been the only
// thing to touch the schema across all three weeks. Left as a plain
// `CREATE TABLE IF NOT EXISTS` rather than introducing migration tooling
// for its own sake; revisit if the schema needs to evolve after v0.1.0
// ships (an ALTER TABLE a real deployment has already run against is a
// different problem than CREATE TABLE IF NOT EXISTS on a fresh DB).
const DDL = `
CREATE TABLE IF NOT EXISTS tool_pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pinned',
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_pins_server_tool ON tool_pins(server_id, tool_name);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  call_hash TEXT NOT NULL UNIQUE,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  principal TEXT NOT NULL,
  canonical_args TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS run_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  source_tool TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS run_tags_run_id ON run_tags(run_id);

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event TEXT NOT NULL,
  call_hash TEXT,
  decision TEXT,
  prev_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  redacted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export type GatekeepDb = BetterSQLite3Database<typeof schema>;

export function openDb(path: string): GatekeepDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
}
