import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Review DB-3: concurrent migrate() calls must apply each migration exactly once and none may fail.
describe("concurrent migrate", () => {
  it.each([1, 2, 3])("run %i: 4 processes, one applies 001_init, the others see it applied", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-migrate-"));
    const file = path.join(dir, "app.db");
    const kids: ChildProcess[] = [];
    const results: { applied?: string[]; error?: string }[] = [];
    const stderr: string[] = [];
    const exits: (number | null)[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        let ready = 0;
        let exited = 0;
        for (let i = 0; i < 4; i++) {
          const c = fork(path.join(__dirname, "migrate-child.ts"), [file], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
          c.stderr?.on("data", (d) => stderr.push(String(d)));
          c.on("message", (m: { type: string; applied?: string[]; error?: string }) => {
            if (m.type === "ready" && ++ready === 4) for (const k of kids) k.send({ type: "go" });
            if (m.type === "done") results.push({ applied: m.applied, error: m.error });
          });
          c.on("exit", (code) => {
            exits.push(code);
            if (++exited === 4) resolve();
          });
          c.on("error", reject);
          kids.push(c);
        }
      });
      const detail = JSON.stringify({ results, exits, stderr: stderr.join("").slice(0, 2000) });
      expect(exits, detail).toEqual([0, 0, 0, 0]);
      expect(results, detail).toHaveLength(4);
      expect(results.filter((r) => r.error), detail).toEqual([]);
      expect(results.filter((r) => r.applied?.includes("001_init")), detail).toHaveLength(1);
    } finally {
      for (const k of kids) if (k.exitCode === null) k.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
