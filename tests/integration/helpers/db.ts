import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type DB } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

/** A fresh, migrated temp database file (never data/app.db, H11). */
export function tempDb(label = "t"): { db: DB; file: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rc-${label}-`));
  const file = path.join(dir, "app.db");
  const db = openDb(file);
  migrate(db, 0);
  return {
    db,
    file,
    dir,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run fn and return the SqliteError's { code, message }, or null if it didn't throw. */
export function sqlError(fn: () => unknown): { code: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code ?? "NO_CODE", message: err.message };
  }
}
