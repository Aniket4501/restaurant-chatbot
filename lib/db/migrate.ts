import fs from "node:fs";
import path from "node:path";
import type { DB } from "@/lib/db/client";
import { immediate } from "@/lib/db/tx";

export const MIGRATIONS_DIR = path.join(process.cwd(), "lib", "db", "migrations");

/** Apply pending `NNN_name.sql` files in order, each in its own IMMEDIATE transaction. Returns versions applied. */
export function migrate(db: DB, now: number, dir = MIGRATIONS_DIR): string[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = new Set(
    hasTable ? (db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map((r) => r.version) : [],
  );
  const done: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    immediate(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now);
    });
    done.push(version);
  }
  return done;
}
