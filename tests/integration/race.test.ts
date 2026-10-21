import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { toInstant } from "@/lib/time/tz";
import { tempDb } from "./helpers/db";

// AC-04 / G-1: 20 separate processes, each with its own connection, race for the one table that fits.
// Party of 5 at Hauz Khas, Sat 17 Oct 20:00: only T5 (4–6) fits. Every child uses a unique key and phone and the
// same fixed `now`, and calls createReservation only after the parent's "go".
const CHILD = path.join(__dirname, "race-child.ts");
const RACERS = 20;
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const START = toInstant("2026-10-17", "20:00", "Asia/Kolkata");
const END = START + 120 * 60_000;
const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));

type Done = { type: "done"; result: { kind: "created" | "error"; status?: number; code?: string; message?: string; ref?: string }; rows: number };

async function race(mode: "service" | "trigger" | "replay" | "same-guest") {
  const sharedKey = randomUUID();
  const t = tempDb("race");
  applySeed(t.db, seed, { now: NOW });
  t.db.close(); // the parent migrated, set WAL and seeded; children open their own connections
  const children: ChildProcess[] = [];
  const results: Done[] = [];
  const exits: (number | null)[] = [];
  const stderr: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = 0;
      for (let i = 0; i < RACERS; i++) {
        const c = fork(CHILD, [t.file, mode, String(i), String(NOW), String(START), String(END), sharedKey], {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        c.stderr?.on("data", (d) => stderr.push(String(d)));
        c.on("message", (m: { type: string }) => {
          if (m.type === "ready" && ++ready === RACERS) for (const k of children) k.send({ type: "go" });
          if (m.type === "done") results.push(m as Done);
        });
        c.on("exit", (code) => {
          exits.push(code);
          if (exits.length === RACERS) resolve();
        });
        c.on("error", reject);
        children.push(c);
      }
    });
  } finally {
    for (const c of children) if (c.exitCode === null) c.kill();
  }
  const { openDb } = await import("@/lib/db/client");
  const db = openDb(t.file);
  const rows = db.prepare("SELECT party_size, starts_at, ends_at FROM reservations").all();
  db.close();
  t.cleanup();
  return { results, exits, rows, stderr: stderr.join("") };
}

describe("20-process race on the last fitting table (AC-04, G-1)", () => {
  it.each(Array.from({ length: 10 }, (_, i) => i + 1))("run %i: exactly 1 booking, 19 SLOT_TAKEN, no server errors", async () => {
    const { results, exits, rows, stderr } = await race("service");
    expect(stderr).toBe("");
    expect(exits.every((c) => c === 0)).toBe(true);
    expect(results).toHaveLength(RACERS);
    expect(results.filter((r) => r.result.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.result.code === "SLOT_TAKEN")).toHaveLength(RACERS - 1);
    expect(results.some((r) => r.result.code === "UNAVAILABLE")).toBe(false); // no SQLITE_BUSY reached the client
    expect(results.every((r) => r.rows === 1)).toBe(true); // every loser saw the winner's committed row
    expect(rows).toEqual([{ party_size: 5, starts_at: START, ends_at: END }]);
  });

  it.each([1, 2, 3])("trigger-only run %i: the database alone lets 1 through and rejects 19 with TABLE_OVERLAP", async () => {
    const { results, exits, rows } = await race("trigger");
    expect(exits.every((c) => c === 0)).toBe(true);
    expect(results.filter((r) => r.result.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.result.code === "SQLITE_CONSTRAINT_TRIGGER" && r.result.message === "TABLE_OVERLAP")).toHaveLength(RACERS - 1);
    expect(rows).toHaveLength(1);
  });
});

// Failure-mode audit FM-012: retries and double taps from separate processes at the same moment.
describe("FM-012 concurrent retries never create a second booking", () => {
  it.each([1, 2, 3])("FM-012 run %i: one shared key from 20 processes: 1 created (201), 19 replays (200) of the same booking", async () => {
    const { results, exits, rows } = await race("replay");
    expect(exits.every((c) => c === 0)).toBe(true);
    expect(results.filter((r) => r.result.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.result.status === 200)).toHaveLength(RACERS - 1);
    expect(new Set(results.map((r) => r.result.ref)).size).toBe(1);
    expect(rows).toHaveLength(1);
  });
  it.each([1, 2])("FM-012 run %i: one guest with a new key from 20 processes: 1 created, 19 DUPLICATE_BOOKING", async () => {
    const { results, rows } = await race("same-guest");
    expect(results.filter((r) => r.result.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.result.code === "DUPLICATE_BOOKING")).toHaveLength(RACERS - 1);
    expect(rows).toHaveLength(1);
  });
});

