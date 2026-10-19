import { openDb } from "@/lib/db/client";

// One of several processes opening the same brand-new database file at the same moment.
const file = process.argv[2];
process.on("message", () => {
  let out: { ok: boolean; mode?: unknown; code?: string; message?: string };
  try {
    const db = openDb(file);
    out = { ok: true, mode: db.pragma("journal_mode", { simple: true }) };
    db.close();
  } catch (e) {
    out = { ok: false, code: (e as { code?: string }).code, message: (e as Error).message };
  }
  process.send!(out, () => process.exit(0));
});
process.send!({ ready: true });
