import path from "node:path";

/** db:reset deletes the database file, so it only ever touches the dev DB, and never in test mode. */
export function assertResettable(databasePath: string, testMode: boolean, cwd: string): void {
  if (testMode) throw new Error("db:reset refuses to run with E2E_TEST_MODE=1");
  if (path.resolve(databasePath) !== path.resolve(cwd, "data", "app.db"))
    throw new Error(`db:reset only resets the dev database (data/app.db), not ${databasePath}`);
}
