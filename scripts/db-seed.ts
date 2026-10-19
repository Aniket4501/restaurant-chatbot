import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed, readSeedDir, SeedConflictError } from "@/lib/db/seed";
import { getConfig } from "@/lib/config";
import { getNow } from "@/lib/time/now";

// npm run db:seed [-- --accept-conflicts]   Loads data/seed/*.json into the configured database (D-14 upsert).
const acceptConflicts = process.argv.includes("--accept-conflicts");
const db = getDb();
try {
  migrate(db, getNow());
  const report = applySeed(db, parseSeed(readSeedDir()), { now: getNow(), acceptConflicts });
  console.log(`seeded ${getConfig().databasePath} (anchor ${report.anchorDate})`, report.counts);
  if (report.deactivated.branches.length || report.deactivated.tables.length) console.log("deactivated:", report.deactivated);
  if (report.conflicts.length) console.warn("accepted conflicts:", report.conflicts);
} catch (e) {
  if (e instanceof SeedConflictError) {
    console.error(e.message);
    for (const c of e.conflicts) console.error(`  ${c.ref} ${c.branch} ${new Date(c.startsAt).toISOString()} ${c.reason}`);
    process.exitCode = 1;
  } else throw e;
} finally {
  closeDb();
}
