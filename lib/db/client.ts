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
  const timeout = opts.timeoutMs ?? 5000;
  const db = new Database(file, { timeout });
  const mode = file === ":memory:" ? "memory" : enableWal(db, timeout);
  if (file !== ":memory:" && mode !== "wal") {
    db.close();
    throw new Error(`SQLite refused WAL mode (got ${String(mode)}); the database must be on a local disk`);
  }
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
  return db;
}

/**
 * Switch to WAL (persistent in the file). If it already is WAL, reading the mode needs no lock. Switching a new file
 * needs an exclusive lock and SQLite returns SQLITE_BUSY at once (no busy handler) when other processes open the same
 * new file concurrently: 15 of 160 opens in a 4-process test. So retry with a short back-off up to the busy timeout.
 */
function enableWal(db: DB, timeoutMs: number): unknown {
  if (db.pragma("journal_mode", { simple: true }) === "wal") return "wal";
  const start = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return db.pragma("journal_mode = WAL", { simple: true });
    } catch (e) {
      const busy = String((e as { code?: string }).code ?? "").startsWith("SQLITE_BUSY");
      if (!busy || performance.now() - start >= timeoutMs) {
        db.close();
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(5 * 2 ** attempt, 100));
    }
  }
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
