import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export function createDb(databasePath: string) {
  const sqlite = new Database(databasePath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec(`CREATE TABLE IF NOT EXISTS channel_configs (
    channel_id TEXT PRIMARY KEY,
    server_url TEXT NOT NULL,
    password TEXT,
    directory TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (current_timestamp)
  )`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS thread_sessions (
    thread_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_sent_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (current_timestamp),
    updated_at TEXT NOT NULL DEFAULT (current_timestamp)
  )`);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export type Db = ReturnType<typeof createDb>["db"];

export { schema };
