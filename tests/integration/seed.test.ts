import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySeed, findConflicts, parseSeed, readSeedDir, SeedConflictError } from "@/lib/db/seed";
import type { SeedData } from "@/lib/db/seed-schema";
import { assertResettable } from "@/lib/db/reset-guard";
import { toInstant } from "@/lib/time/tz";
import { tempDb } from "./helpers/db";

const ROOT = path.resolve(__dirname, "../..");
const fixture = (): SeedData => parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8")));
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const IST = "Asia/Kolkata";

let t: ReturnType<typeof tempDb>;
beforeEach(() => (t = tempDb("seed")));
afterEach(() => t.cleanup());

const count = (table: string, where = "1") => (t.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

function book(ref: string, branch: string, label: string, date: string, time: string, minutes: number, party = 4) {
  const b = t.db.prepare("SELECT id FROM branches WHERE slug = ?").get(branch) as { id: number };
  const tb = t.db.prepare("SELECT id FROM dining_tables WHERE branch_id = ? AND label = ?").get(b.id, label) as { id: number };
  const start = toInstant(date, time, IST);
  t.db
    .prepare(`INSERT INTO reservations (id, ref, branch_id, table_id, guest_name, phone_e164, party_size, starts_at, ends_at, idempotency_key, request_hash, created_at)
      VALUES (?, ?, ?, ?, 'Asha', '+919876543210', ?, ?, ?, ?, 'h', 0)`)
    .run(ref, ref, b.id, tb.id, party, start, start + minutes * 60_000, `key-${ref}`);
}

describe("seed loader (BR-01..BR-03, BR-14, D-14)", () => {
  it("loads the eval fixture with the expected shape", () => {
    const r = applySeed(t.db, fixture(), { now: NOW });
    expect(r.counts).toEqual({ branches: 2, service_hours: 27, hours_exceptions: 5, dining_tables: 12, menu_items: 48, faq_entries: 25 });
    expect(t.db.prepare("SELECT name FROM restaurant").get()).toEqual({ name: "Neem & Ember" });
    // Gurugram has no Monday lunch row (BR-02).
    expect(count("service_hours", "branch_id = (SELECT id FROM branches WHERE slug = 'gurugram') AND weekday = 1 AND service = 'lunch'")).toBe(0);
    expect(count("menu_items", "is_available = 0")).toBe(1);
    expect(r.anchorDate).toBe("2026-10-16");
  });

  it("loads the demo seed (data/seed) and resolves relative dates against the anchor", () => {
    const r = applySeed(t.db, parseSeed(readSeedDir()), { now: NOW });
    expect(r.counts.hours_exceptions).toBe(5);
    expect((t.db.prepare("SELECT DISTINCT date FROM hours_exceptions ORDER BY date").all() as { date: string }[]).map((x) => x.date)).toEqual(["2026-10-19", "2026-10-24", "2026-10-28"]);
  });

  it("is idempotent and reuses the stored anchor on later reseeds", () => {
    const seed = parseSeed(readSeedDir());
    applySeed(t.db, seed, { now: NOW });
    const later = Date.parse("2026-11-01T10:00:00+05:30");
    const r = applySeed(t.db, seed, { now: later });
    expect(r.anchorDate).toBe("2026-10-16");
    expect(r.counts).toEqual({ branches: 2, service_hours: 27, hours_exceptions: 5, dining_tables: 12, menu_items: 48, faq_entries: 25 });
    expect(count("hours_exceptions", "date = '2026-10-19'")).toBe(2);
  });

  it("deactivates a removed table instead of deleting it, keeping its bookings", () => {
    applySeed(t.db, fixture(), { now: NOW });
    book("NE-AAAAAAA1", "hauz-khas", "T6", "2026-10-10", "19:00", 120, 7); // past booking on T6
    const seed = fixture();
    seed.tables = seed.tables.filter((x) => !(x.branch === "hauz-khas" && x.label === "T6"));
    const r = applySeed(t.db, seed, { now: NOW });
    expect(r.deactivated.tables).toEqual(["hauz-khas/T6"]);
    expect(count("dining_tables")).toBe(12);
    expect(count("dining_tables", "is_active = 0")).toBe(1);
    expect(count("reservations")).toBe(1);
  });

  it("refuses a reseed that invalidates a confirmed future booking, and rolls back", () => {
    applySeed(t.db, fixture(), { now: NOW });
    book("NE-AAAAAAA2", "hauz-khas", "T3", "2026-10-21", "20:00", 90);
    const seed = fixture();
    seed.exceptions.push(
      { branch: "hauz-khas", date: "2026-10-21", service: "lunch", isClosed: false, opens: "12:00", closes: "15:30", note: null },
      { branch: "hauz-khas", date: "2026-10-21", service: "dinner", isClosed: true, opens: null, closes: null, note: "Staff party" },
    );
    expect(() => applySeed(t.db, seed, { now: NOW })).toThrow(SeedConflictError);
    expect(count("hours_exceptions")).toBe(5); // rolled back
    const r = applySeed(t.db, seed, { now: NOW, acceptConflicts: true });
    expect(r.conflicts).toEqual([{ ref: "NE-AAAAAAA2", branch: "hauz-khas", startsAt: toInstant("2026-10-21", "20:00", IST), reason: "outside_hours" }]);
    expect(count("hours_exceptions")).toBe(7);
  });

  it("ignores past bookings and cancelled ones when checking conflicts", () => {
    applySeed(t.db, fixture(), { now: NOW });
    book("NE-AAAAAAA3", "hauz-khas", "T3", "2026-10-22", "20:00", 90); // dinner on 22 Oct is closed in the fixture
    expect(findConflicts(t.db, NOW).map((c) => c.reason)).toEqual(["outside_hours"]);
    t.db.prepare("UPDATE reservations SET status = 'cancelled' WHERE ref = 'NE-AAAAAAA3'").run();
    expect(findConflicts(t.db, NOW)).toEqual([]);
  });
});

describe("seed validation (D-08 exception rules)", () => {
  const withExceptions = (ex: SeedData["exceptions"]) => ({ ...fixture(), exceptions: ex });
  const issues = (raw: unknown) => {
    try {
      parseSeed(raw);
      return [];
    } catch (e) {
      return (e as { issues: { message: string }[] }).issues.map((i) => i.message);
    }
  };
  it("rejects a whole-day exception beside per-service rows", () => {
    expect(
      issues(withExceptions([
        { branch: "gurugram", date: "2026-10-27", service: null, isClosed: true, opens: null, closes: null, note: null },
        { branch: "gurugram", date: "2026-10-27", service: "lunch", isClosed: true, opens: null, closes: null, note: null },
      ])).join(),
    ).toMatch(/whole-day exception beside per-service rows/);
  });
  it("rejects per-service exceptions that omit a service", () => {
    expect(issues(withExceptions([{ branch: "hauz-khas", date: "2026-10-22", service: "dinner", isClosed: true, opens: null, closes: null, note: null }])).join()).toMatch(
      /must list both lunch and dinner/,
    );
  });
  it("rejects a whole-day opening and unpadded times", () => {
    expect(issues(withExceptions([{ branch: "hauz-khas", date: "2026-10-22", service: null, isClosed: false, opens: "12:00", closes: "15:00", note: null }])).join()).toMatch(/whole-day exception can only be a closure/);
    expect(issues(withExceptions([{ branch: "hauz-khas", date: "+3d", service: null, isClosed: true, opens: "9:00", closes: null, note: null }])).join()).toMatch(/HH:MM/);
  });
  it("rejects unknown branches, duplicate slugs and bad data", () => {
    const f = fixture();
    expect(issues({ ...f, tables: [...f.tables, { branch: "noida", label: "T1", minSeats: 1, maxSeats: 2, isActive: true }] }).join()).toMatch(/unknown branch noida/);
    expect(issues({ ...f, menu: [...f.menu, f.menu[0]] }).join()).toMatch(/duplicate dahi-puri-shots/);
    expect(issues({ ...f, menu: [{ ...f.menu[1], dietary: ["vegan", "contains-dairy"] }] }).join()).toMatch(/vegan item lists dairy/);
    expect(issues({ ...f, branches: [{ ...f.branches[0], phone: "011 4155 0101" }, f.branches[1]] }).join()).toMatch(/E\.164/);
  });
});

describe("db:reset guard", () => {
  it("allows only the dev database outside test mode", () => {
    expect(() => assertResettable(path.join(ROOT, "data/app.db"), false, ROOT)).not.toThrow();
    expect(() => assertResettable(path.join(ROOT, "data/app.db"), true, ROOT)).toThrow(/E2E_TEST_MODE/);
    expect(() => assertResettable("/tmp/other.db", false, ROOT)).toThrow(/only resets the dev database/);
  });
});
