import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReservation } from "@/lib/booking/create";
import type { Block, TraceEntry } from "@/lib/chat/types";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { toInstant } from "@/lib/time/tz";
import { loadCases, type EvalCase } from "@/evals/case";
import { checkCase, claimIn, guestPii, offeredStarts, snapshotRows, unsupportedToken, type CaseRecord, type TurnRecord } from "@/evals/invariants";
import { runCase } from "@/evals/run";
import { tempDb } from "./helpers/db";

const ROOT = path.resolve(__dirname, "../..");
const run = promisify(execFile);
const evalCli = (args: string[]) =>
  run(process.execPath, ["--import", "tsx", "evals/run.ts", ...args], { cwd: ROOT, maxBuffer: 10 * 2 ** 20 }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const seed = parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8")));

describe("npm run eval:scripted (D1, INV-08)", () => {
  it("passes every scripted case with no invariant violations", async () => {
    const r = await evalCli(["--mode", "scripted", "--out", path.join(os.tmpdir(), `rc-eval-${process.pid}.json`)]);
    expect(r.out).toMatch(/eval:scripted (\d+)\/\1 passed, 0 invariant violations/);
    expect(r.code).toBe(0);
  });

  it("covers every D1 category of T-14 with at least two cases (§6.2)", () => {
    const cases = loadCases(path.join(ROOT, "evals/cases")).filter((c) => c.mode === "scripted");
    for (const cat of ["missing_info", "slot_unavailable", "booking_success", "malformed_output", "backend_failure", "false_claim", "retry_after_timeout", "context_loss"])
      expect(cases.filter((c) => c.category === cat).length, cat).toBeGreaterThanOrEqual(2);
  });

  describe("a deliberately failing or invalid case dir", () => {
    let dir: string;
    beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-cases-"))));
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const original = () => loadCases(path.join(ROOT, "evals/cases")).find((c) => c.id === "SC-MISS-001")!;
    const write = (cases: unknown[]) => fs.writeFileSync(path.join(dir, "x.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n"));

    it("exits non-zero when an expectation fails", async () => {
      write([{ ...original(), expect: { ...original().expect, fieldRequest: "date" } }]);
      const r = await evalCli(["--mode", "scripted", "--cases", dir, "--out", path.join(dir, "out.json")]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/FAIL SC-MISS-001 missing_info\n {5}case: no field_request for date/);
      expect(r.out).toMatch(/eval:scripted 0\/1 passed/);
    });
    it("rejects unknown categories, keys and duplicate IDs before running anything", async () => {
      for (const bad of [[{ ...original(), category: "chit_chat" }], [{ ...original(), expect: { intnet: "booking" } }], [original(), original()]]) {
        write(bad);
        const r = await evalCli(["--mode", "scripted", "--cases", dir]);
        expect(r.code).toBe(2);
        expect(r.out).toMatch(/x\.jsonl:\d+: /);
      }
      const r = await evalCli(["--mode", "scripted", "--category", "chit_chat"]);
      expect([r.code, r.out.trim()]).toEqual([2, "unknown category chit_chat"]);
    });
    it("refuses live mode until the Ollama chat client exists (T-18)", async () => {
      const r = await evalCli(["--mode", "live"]);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/needs the Ollama chat client/);
    });
  });

  it("fails a case whose model script has unused replies", async () => {
    const c = loadCases(path.join(ROOT, "evals/cases")).find((x) => x.id === "SC-MISS-001")!;
    const r = await runCase({ ...c, modelScript: [...c.modelScript!, "<<TIMEOUT>>"] } as EvalCase, { mode: "scripted" });
    expect(r.passed).toBe(false);
    expect(r.failures).toContain("modelScript has 1 unused replies");
  });
});

describe("invariants detect violations (§6.4)", () => {
  let t: ReturnType<typeof tempDb>;
  beforeEach(() => {
    t = tempDb("inv");
    applySeed(t.db, seed, { now: NOW });
  });
  afterEach(() => t.cleanup());

  const turn = (o: Partial<TurnRecord>): TurnRecord => ({ index: 0, kind: "guest", now: NOW, shown: { text: "", blocks: [] }, outcome: null, citedFactIds: [], factText: new Map(), trace: [], rowsBefore: [], rowsAfter: [], offered: [], prompts: [], ...o });
  const record = (turns: TurnRecord[], o: Partial<CaseRecord> = {}): CaseRecord => ({ turns, setupRefs: new Set(), guestTexts: [], submittedNames: [], submittedPii: [], chatTurns: [], logs: [], ...o });
  const invs = (rec: CaseRecord) => checkCase(t.db, rec).map((v) => v.inv);
  const book = (time: string, phone = "+919876543210") => {
    const r = createReservation(t.db, { branch: "hauz-khas", startsAt: toInstant("2026-10-17", time, "Asia/Kolkata"), partySize: 2, name: "Asha Rao", phone }, crypto.randomUUID(), NOW);
    if (!("reservation" in r)) throw new Error(r.code);
    return r.reservation;
  };
  const confirmation = (ref: string, partySize = 2): Block => ({ type: "confirmation", ref, status: "confirmed", branchName: "x", address: "x", phone: "x", dateLabel: "x", timeLabel: "x", partySize, guestName: "x" });

  it("INV-01: a confirmation needs a matching confirmed row created in the run", () => {
    const r = book("20:00");
    const rows = snapshotRows(t.db);
    expect(invs(record([turn({ shown: { text: "", blocks: [confirmation(r.ref)] }, rowsBefore: rows, rowsAfter: rows })]))).toEqual([]);
    expect(invs(record([turn({ shown: { text: "", blocks: [confirmation("NE-AAAAAAAA")] }, rowsBefore: rows, rowsAfter: rows })]))).toEqual(["INV-01"]);
    expect(invs(record([turn({ shown: { text: "", blocks: [confirmation(r.ref, 4)] }, rowsBefore: rows, rowsAfter: rows })]))).toEqual(["INV-01"]);
    expect(invs(record([turn({ shown: { text: "", blocks: [confirmation(r.ref)] }, rowsBefore: rows, rowsAfter: rows })], { setupRefs: new Set([r.ref]) }))).toEqual(["INV-01"]);
  });

  it("INV-02: overlapping confirmed rows on one table (triggers bypassed to plant one)", () => {
    const a = book("20:00");
    t.db.exec("DROP TRIGGER no_table_overlap_ins; DROP TRIGGER no_guest_overlap_ins;");
    const row = t.db.prepare("SELECT * FROM reservations WHERE ref = ?").get(a.ref) as Record<string, unknown>;
    t.db.prepare("INSERT INTO reservations (id, ref, branch_id, table_id, guest_name, phone_e164, party_size, starts_at, ends_at, idempotency_key, request_hash, created_at) VALUES ('x', 'NE-BBBBBBBB', ?, ?, 'Bo Lee', '+919800000001', 2, ?, ?, 'k2', 'h', 0)").run(
      row.branch_id,
      row.table_id,
      (row.starts_at as number) + 1_800_000,
      (row.ends_at as number) + 1_800_000,
    );
    expect(invs(record([]))).toEqual(["INV-02"]);
  });

  it("INV-03: an offered start the engine doesn't have open", () => {
    const blocks: Block[] = [{ type: "confirm", branch: "hauz-khas", branchName: "", address: "", phone: "", date: "2026-10-17", dateLabel: "", time: "03:00", timeLabel: "", startsAt: "", startsAtMs: toInstant("2026-10-17", "03:00", "Asia/Kolkata"), partySize: 2, sittingMinutes: 90 }];
    const offered = offeredStarts(t.db, blocks, NOW);
    expect(offered).toEqual([{ branch: "hauz-khas", startsAt: blocks[0].type === "confirm" ? blocks[0].startsAtMs : 0, partySize: 2, open: false }]);
    expect(invs(record([turn({ offered })]))).toEqual(["INV-03"]);
  });

  it("INV-04: claim text only with a successful create in the same turn", () => {
    const created: TraceEntry[] = [{ action: "create_reservation", result: { status: 201, code: null, ref: "NE-AAAAAAAA" } }];
    expect(invs(record([turn({ shown: { text: "Your table is booked for 8 PM.", blocks: [] } })]))).toEqual(["INV-04"]);
    expect(invs(record([turn({ shown: { text: "You're booked. Your reference is NE-AAAAAAAA.", blocks: [] }, trace: created })]))).not.toContain("INV-04");
    for (const ok of ["Your table isn't booked yet. Tap Confirm to finish.", "Walk-ins are welcome when a table is free.", "I can help with bookings, hours, locations and the menu."]) expect(claimIn(ok), ok).toBeNull();
    for (const bad of ["We've reserved a table for you.", "You're all set!", "See you tonight!", "Tables are still available at 9.", "There's a table available at 8 PM.", "Yes, tables are available for 2 guests on Monday night."])
      expect(claimIn(bad), bad).not.toBeNull();
  });

  it("INV-05: shown prose must use only digit runs and number words from its cited facts (stricter than grounding)", () => {
    const facts = new Map([["menu:old-delhi-butter-chicken", "Old Delhi Butter Chicken (mains), ₹645."], ["hours:hauz-khas:fri", "Hauz Khas on Fridays: dinner 7:00 PM–11:00 PM."]]);
    const shown = (text: string, cited: string[]) => record([turn({ outcome: "faq_answer", shown: { text, blocks: [] }, citedFactIds: cited, factText: facts })]);
    expect(invs(shown("It is ₹645.", ["menu:old-delhi-butter-chicken"]))).toEqual([]);
    expect(invs(shown("It is ₹745.", ["menu:old-delhi-butter-chicken"]))).toEqual(["INV-05"]);
    expect(invs(shown("Dinner until 11 PM.", ["hours:hauz-khas:fri"]))).toEqual([]);
    expect(unsupportedToken("Dinner until 23:00.", facts.get("hours:hauz-khas:fri")!)).toBe("23"); // production grounding accepts this; INV-05 does not
    expect(unsupportedToken("Dinner until midnight.", facts.get("hours:hauz-khas:fri")!)).toBe("midnight");
  });

  it("INV-06: rows change only through a successful create", () => {
    const before = snapshotRows(t.db);
    const r = book("20:00");
    const after = snapshotRows(t.db);
    const created: TraceEntry[] = [{ action: "create_reservation", result: { status: 201, code: null, ref: r.ref } }];
    expect(invs(record([turn({ kind: "submit", rowsBefore: before, rowsAfter: after, trace: created })]))).toEqual([]);
    expect(invs(record([turn({ kind: "guest", rowsBefore: before, rowsAfter: after })]))).toEqual(["INV-06"]);
    const cancelled = after.map((x) => ({ ...x, status: "cancelled" }));
    expect(invs(record([turn({ kind: "guest", rowsBefore: after, rowsAfter: cancelled })]))).toEqual(["INV-06"]);
  });

  it("INV-07: no guest phone or email in prompts, no guest text in chat_turns or logs", () => {
    const guest = ["my number is 98765 43210 and mail a@b.com"];
    expect(guestPii(guest)).toEqual(expect.arrayContaining(["98765 43210", "9876543210", "a@b.com"]));
    expect(invs(record([turn({ prompts: ["…<guest_message>my number is [phone] and mail [email]</guest_message>"] })], { guestTexts: guest }))).toEqual([]);
    expect(invs(record([turn({ prompts: ["…my number is 98765 43210…"] })], { guestTexts: guest }))).toContain("INV-07");
    expect(invs(record([], { guestTexts: guest, chatTurns: [{ outcome: "my number is 98765 43210 and mail a@b.com" }] }))).toContain("INV-07");
    expect(invs(record([], { submittedNames: ["Asha Rao"], logs: ["created booking for Asha Rao"] }))).toEqual(["INV-07"]);
    expect(invs(record([], { submittedPii: ["98765 43210", "9876543210", "asha@example.com"], logs: ["create failed for +919876543210"] }))).toEqual(["INV-07"]); // review UI-3
  });
});
