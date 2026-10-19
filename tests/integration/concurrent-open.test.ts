import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Found while stabilising the concurrent-migrate test: several processes opening the same NEW file got
// SQLITE_BUSY from the WAL switch (no busy handler applies). openDb now retries with back-off.
async function openRace(): Promise<{ ok: boolean; mode?: unknown; code?: string; message?: string }[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-open-"));
  const file = path.join(dir, "app.db");
  const kids: ChildProcess[] = [];
  const results: { ok: boolean; mode?: unknown; code?: string; message?: string }[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = 0;
      for (let i = 0; i < 4; i++) {
        const c = fork(path.join(__dirname, "open-child.ts"), [file], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
        c.on("message", (m: { ready?: boolean; ok?: boolean }) => {
          if (m.ready && ++ready === 4) for (const k of kids) k.send("go");
          if (m.ok !== undefined) results.push(m as { ok: boolean });
          if (results.length === 4) resolve();
        });
        c.on("error", reject);
        kids.push(c);
      }
    });
  } finally {
    for (const k of kids) if (k.exitCode === null) k.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

describe("concurrent openDb on a new file", () => {
  it("opens in WAL mode from 4 processes at once, 10 runs in a row", async () => {
    for (let run = 0; run < 10; run++) {
      const results = await openRace();
      expect(results, JSON.stringify(results)).toEqual(Array(4).fill({ ok: true, mode: "wal" }));
    }
  });
});
