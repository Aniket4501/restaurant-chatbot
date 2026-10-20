import { defineConfig, devices } from "@playwright/test";
import { E2E_ADMIN, E2E_NOW, PORTS, serverFiles } from "./tests/e2e/env";

// E2E harness (D-12). Two production servers from one `next build` (npm run test:e2e builds first), both on 127.0.0.1,
// never reused, in test mode with the fake model and fake embedder, each on its own temp database under test-results/:
// - 3100: high limits, used by almost every spec;
// - 3101: low limits, for the 429 and sign-in throttling specs.
// Each server's stdout/stderr goes to test-results/e2e/server-<port>.log, which the INV-07 check scans.
function server(port: number, limits: Record<string, string>) {
  const f = serverFiles(port);
  return {
    command: `mkdir -p test-results/e2e && npx tsx scripts/e2e-prepare.ts > ${f.log} 2>&1 && npx next start -H 127.0.0.1 -p ${port} >> ${f.log} 2>&1`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      E2E_TEST_MODE: "1",
      LLM_PROVIDER: "fake",
      EMBED_PROVIDER: "fake",
      DATABASE_PATH: f.db,
      TEST_TRACE_PATH: f.trace,
      NOW_OVERRIDE: E2E_NOW,
      FAKE_SCRIPT: "tests/e2e/fake-script.json",
      ADMIN_PASSWORD: E2E_ADMIN.password,
      ADMIN_SESSION_SECRET: E2E_ADMIN.secret,
      ...limits,
    },
  };
}

export default defineConfig({
  testDir: "tests/e2e",
  // Playwright empties its outputDir at the start of a run; keep it off test-results/ itself, which holds the E2E
  // servers' databases and logs, the eval results and the verify logs.
  outputDir: "test-results/playwright",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${PORTS.main}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    server(PORTS.main, { RATE_LIMIT_TURNS_PER_MIN: "1000", ADMIN_LOGIN_PER_MIN: "1000", RESERVATION_CREATES_PER_MIN: "1000" }),
    server(PORTS.lowLimit, { RATE_LIMIT_TURNS_PER_MIN: "3", ADMIN_LOGIN_PER_MIN: "2", RESERVATION_CREATES_PER_MIN: "2" }),
  ],
});
