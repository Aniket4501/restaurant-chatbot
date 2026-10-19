import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed, readSeedDir } from "@/lib/db/seed";
import { getNow } from "@/lib/time/now";
import { assertResettable } from "@/lib/db/reset-guard";

// npm run db:reset   Deletes and rebuilds the DEV database only (data/app.db): migrate, then seed.
const config = getConfig();
assertResettable(config.databasePath, config.testMode, process.cwd());
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${config.databasePath}${suffix}`, { force: true });
const db = getDb();
migrate(db, getNow());
const report = applySeed(db, parseSeed(readSeedDir()), { now: getNow() });
console.log(`reset ${path.relative(process.cwd(), config.databasePath)} (anchor ${report.anchorDate})`, report.counts);
closeDb();
