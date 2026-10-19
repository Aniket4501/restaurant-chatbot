import { defineConfig } from "vitest/config";

// Two projects (D-07): unit (pure, fast; also run under TZ=UTC and TZ=America/New_York) and integration
// (real temp SQLite files and child processes; serial, long timeout for the 20-process race test).
// The default "forks" pool is kept so TZ= takes effect in workers.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
