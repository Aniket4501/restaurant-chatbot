import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiDeps } from "@/lib/api/deps";
import { testResetHandler } from "@/lib/api/test-reset";
import { loadConfig } from "@/lib/config";
import { createLimiter } from "@/lib/http/ratelimit";
import { runSteps, verifySteps } from "../../scripts/verify";
import { testChatDeps } from "../helpers/chat-deps";

describe("npm run verify (INV-08)", () => {
  it("prints one line per step, skips steps whose dependency failed, and reports the failure", async () => {
    const lines: string[] = [];
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-verify-"));
    const results = await runSteps(
      [
        { name: "ok-step", cmd: [process.execPath, "-e", "process.exit(0)"] },
        { name: "build", cmd: [process.execPath, "-e", "process.exit(3)"] },
        { name: "test:e2e", needs: "build", cmd: [process.execPath, "-e", "process.exit(0)"] },
        { name: "report", run: async () => "2 violations" },
      ],
      (l) => lines.push(l),
      logDir,
    );
    expect(results.map((r) => [r.name, r.ok, r.skipped])).toEqual([
      ["ok-step", true, false],
      ["build", false, false],
      ["test:e2e", false, true],
      ["report", false, false],
    ]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^✓ ok-step/);
    expect(lines[1]).toMatch(/^✗ build .* exit 3 → .*build\.log$/);
    expect(fs.existsSync(path.join(logDir, "build.log"))).toBe(true);
    fs.rmSync(logDir, { recursive: true, force: true });
    expect(lines[2]).toBe("- test:e2e           skipped (build failed)");
    expect(lines[3]).toMatch(/^✗ report .* 2 violations$/);
  });
  it("runs the §8 Phase 4 steps in order; release adds model:check and the 3-run eval", () => {
    expect(verifySteps(false).map((s) => s.name)).toEqual(["lint", "typecheck", "test:unit", "test:unit:tz", "test:integration", "eval:scripted", "build", "test:e2e", "invariants"]);
    expect(verifySteps(true).map((s) => s.name).slice(-2)).toEqual(["model:check", "eval (3 runs)"]);
  });
});

describe("POST /api/__test/reset", () => {
  it("is 404 outside test mode and never touches the database", async () => {
    const deps = {
      db: () => {
        throw new Error("must not open the database");
      },
      now: () => 0,
      config: () => loadConfig({ DATABASE_PATH: path.join(os.tmpdir(), "x.db") }),
      fetch,
      limits: { createsPerPhone: createLimiter({ limit: 1, windowMs: 1 }), createsGlobal: createLimiter({ limit: 1, windowMs: 1 }) },
      chat: testChatDeps(),
    } as unknown as ApiDeps;
    const res = await testResetHandler(deps)();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});
