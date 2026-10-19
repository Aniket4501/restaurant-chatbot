import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

// One of several processes running migrate() on the same fresh file at the same moment (review DB-3).
process.on("message", (m: { type: string }) => {
  if (m.type !== "go") return;
  let out: { applied?: string[]; error?: string };
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(process.argv[2]); // opened after "go", so all 4 open the new file at the same moment
    out = { applied: migrate(db, 0) };
  } catch (e) {
    out = { error: (e as Error).message };
  }
  process.send!({ type: "done", ...out }, () => {
    db?.close();
    process.exit(0);
  });
});
process.send!({ type: "ready" });
