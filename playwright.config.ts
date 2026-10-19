import { defineConfig, devices } from "@playwright/test";

// T-01 skeleton. T-15 adds the reset route, the trace file, the second low-limit server (port 3101),
// and the fake-provider and temp-DB environment (D-12). The server always binds 127.0.0.1 and is never reused,
// so tests can't attach to a dev server running the real model.
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3100" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && NEXT_TELEMETRY_DISABLED=1 npx next start -H 127.0.0.1 -p 3100",
    url: "http://127.0.0.1:3100/",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
