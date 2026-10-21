import fs from "node:fs";
import path from "node:path";
import type { DB } from "@/lib/db/client";
import { immediate } from "@/lib/db/tx";

export const MIGRATIONS_DIR = path.join(process.cwd(), "lib", "db", "migrations");

const migrationFiles = (dir: string) =>
  fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();

/** Migrations in `dir` the database hasn't applied (failure-mode audit FM-028: health said ok one migration behind). */
export function pendingMigrations(db: DB, dir = MIGRATIONS_DIR): string[] {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = new Set(hasTable ? (db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map((r) => r.version) : []);
  return migrationFiles(dir)
    .map((f) => f.replace(/\.sql$/, ""))
    .filter((v) => !applied.has(v));
}

/** Apply pending `NNN_name.sql` files in order, each in its own IMMEDIATE transaction. Returns versions applied. */
export function migrate(db: DB, now: number, dir = MIGRATIONS_DIR): string[] {
  const files = migrationFiles(dir);
  const done: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    // The applied check runs under the write lock, so concurrent migrate() calls apply each file once (review DB-3).
    const applied = immediate(db, () => {
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
      if (hasTable && db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)) return false;
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now);
      return true;
    });
    if (applied) done.push(version);
  }
  return done;
}
