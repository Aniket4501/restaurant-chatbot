import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "@/lib/config";
import { closeDb, getDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { fakeEmbedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { indexKb } from "@/lib/kb/index";

// Test-mode database reset (D-12): a fresh database from evals/fixtures/base.json, indexed with the fake embedder,
// and an empty trace file. Used by scripts/e2e-prepare.ts before the E2E servers start and by POST /api/__test/reset
// before each spec. Refuses to run outside test mode; in test mode lib/config has already refused data/app.db and any
// path outside the OS temp dir or test-results/.

export async function resetTestDatabase(config: AppConfig, now: number): Promise<{ databasePath: string; facts: number }> {
  if (!config.testMode) throw new Error("resetTestDatabase: E2E_TEST_MODE=1 is required");
  if (path.basename(config.databasePath) === "app.db" && path.basename(path.dirname(config.databasePath)) === "data") throw new Error("resetTestDatabase: refusing data/app.db");
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${config.databasePath}${suffix}`, { force: true });
  const db = getDb();
  migrate(db, now);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals/fixtures/base.json"), "utf8"))), { now });
  const facts = renderKbFacts(loadFactSource(db));
  await indexKb(db, facts, fakeEmbedder(), now);
  if (config.test?.tracePath) {
    fs.mkdirSync(path.dirname(config.test.tracePath), { recursive: true });
    fs.writeFileSync(config.test.tracePath, "");
  }
  return { databasePath: config.databasePath, facts: facts.length };
}
