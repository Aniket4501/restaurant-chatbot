import { getConfig } from "@/lib/config";
import { closeDb } from "@/lib/db/client";
import { resetTestDatabase } from "@/lib/testing/reset";
import { getNow } from "@/lib/time/now";

// Run by each Playwright webServer before `next start` (test mode only): the server starts on a ready database.
const r = await resetTestDatabase(getConfig(), getNow());
console.log(`e2e-prepare: ${r.databasePath} ready (${r.facts} facts indexed)`);
closeDb();
