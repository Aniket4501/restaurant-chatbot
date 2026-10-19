import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "@/lib/config";

export type DB = Database.Database;

/**
 * Open a connection with the D-08 settings. PRAGMAs live here, never in migrations:
 * - busy timeout 5000 ms (explicit; also the better-sqlite3 default)
 * - WAL, asserted (SQLite silently keeps another mode if it can't switch)
 * - foreign keys on (per connection)
 * - synchronous=FULL, so a commit survives power loss; WAL would otherwise default to NORMAL after reopen
 */
export function openDb(file: string, opts: { timeoutMs?: number } = {}): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { timeout: opts.timeoutMs ?? 5000 });
  const mode = db.pragma("journal_mode = WAL", { simple: true });
  if (file !== ":memory:" && mode !== "wal") {
    db.close();
    throw new Error(`SQLite refused WAL mode (got ${String(mode)}); the database must be on a local disk`);
  }
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
  return db;
}

let shared: DB | null = null;

/** Process-wide connection, opened lazily (never at module import: `next build` evaluates route modules). */
export function getDb(): DB {
  shared ??= openDb(getConfig().databasePath);
  return shared;
}

export function closeDb(): void {
  shared?.close();
  shared = null;
}
