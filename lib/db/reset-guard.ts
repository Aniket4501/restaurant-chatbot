import path from "node:path";
import Database from "better-sqlite3";

/** db:reset deletes the database file, so it only ever touches the dev DB, and never in test mode. */
export function assertResettable(databasePath: string, testMode: boolean, cwd: string): void {
  if (testMode) throw new Error("db:reset refuses to run with E2E_TEST_MODE=1");
  if (path.resolve(databasePath) !== path.resolve(cwd, "data", "app.db"))
    throw new Error(`db:reset only resets the dev database (data/app.db), not ${databasePath}`);
}

/**
 * Refuse to delete a database another process has open (review DB-2): leaving WAL mode needs exclusive access,
 * so with any other connection open this fails with SQLITE_BUSY at once (timeout 0).
 */
export function assertNotInUse(file: string): void {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 0 });
    db.pragma("journal_mode = DELETE");
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code === "SQLITE_CANTOPEN") return; // nothing to delete
    if (code.startsWith("SQLITE_BUSY")) throw new Error("db:reset: the database is in use. Stop `npm run dev`/`start` (and anything else using it) first.");
    throw e;
  } finally {
    db?.close();
  }
}
