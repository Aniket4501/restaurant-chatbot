import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { closeDb } from "@/lib/db/client";
import { resetTestDatabase } from "@/lib/testing/reset";
import { getNow } from "@/lib/time/now";

// Run by each Playwright webServer before `next start` (test mode only): the server starts on a ready database.
const r = await resetTestDatabase(getConfig(), getNow());
console.log(`e2e-prepare: ${r.databasePath} ready (${r.facts} facts indexed)`);
closeDb();
// D-21: a fresh evals results directory for the dashboard specs, seeded with two fixture runs and a baseline.
const evals = process.env.EVALS_RESULTS_DIR;
if (evals && process.env.E2E_TEST_MODE === "1") {
  fs.rmSync(evals, { recursive: true, force: true });
  fs.mkdirSync(evals, { recursive: true });
  const src = path.join(process.cwd(), "tests/e2e/fixtures/evals");
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(evals, f));
  if (process.env.EVALS_BASELINE_FILE) fs.writeFileSync(process.env.EVALS_BASELINE_FILE, JSON.stringify({ "live-full": { id: "2026-10-20T10-00-00-000Z_qwen3.5-9b_e2e-base", setAt: "2026-10-20T12:00:00.000Z", note: "e2e fixture" } }));
  console.log(`e2e-prepare: ${evals} seeded with ${fs.readdirSync(evals).length} eval runs`);
}
