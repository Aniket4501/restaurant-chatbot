import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelReservation } from "@/lib/booking/cancel";
import { createReservation, mapConstraintError, requestHash, CreateBodySchema, type CreateResult } from "@/lib/booking/create";
import { getAvailability } from "@/lib/booking/availability";
import { loadAvailabilityData } from "@/lib/booking/load";
import { REF_RE } from "@/lib/booking/ref";
import { openDb } from "@/lib/db/client";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { toInstant } from "@/lib/time/tz";
import { tempDb } from "./helpers/db";

// §5.6 write path: AC-05 (idempotent replay), AC-06 (duplicate guest), BR-09/BR-11/BR-12, G-1…G-4, D-14 typed errors.
const IST = "Asia/Kolkata";
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const at = (date: string, time: string) => toInstant(date, time, IST);
const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));

let t: ReturnType<typeof tempDb>;
beforeEach(() => {
  t = tempDb("booking");
  applySeed(t.db, seed, { now: NOW });
});
afterEach(() => t.cleanup());

const body = (o: Record<string, unknown> = {}) => ({ branch: "hauz-khas", startsAt: at("2026-10-17", "20:00"), partySize: 4, name: "Asha Rao", phone: "98765 43210", email: null, note: null, ...o });
const rows = () => (t.db.prepare("SELECT count(*) AS n FROM reservations").get() as { n: number }).n;
function created(r: CreateResult) {
  if (!("reservation" in r)) throw new Error(`expected a reservation, got ${r.code}`);
  return r.reservation;
}

describe("create", () => {
  it("saves the row and returns 201 with the saved view (G-3, BR-12)", () => {
    const r = createReservation(t.db, body({ note: "  window seat please  ", email: "Asha@Example.COM" }), randomUUID(), NOW);
    expect(r).toMatchObject({ status: 201 });
    const v = created(r);
    expect(v.ref).toMatch(REF_RE);
    expect(v).toMatchObject({ status: "confirmed", partySize: 4, guestName: "Asha Rao", date: "2026-10-17", time: "20:00", timeLabel: "8:00 PM", dateLabel: "Sat 17 Oct 2026" });
    expect(v.branch).toEqual({ slug: "hauz-khas", name: "Neem & Ember, Hauz Khas", address: "24 Hauz Khas Village, New Delhi 110016", phone: "+911141550101" });
    const saved = t.db.prepare("SELECT phone_e164, email, note, table_id, ends_at - starts_at AS len FROM reservations WHERE ref = ?").get(v.ref) as Record<string, unknown>;
    expect(saved).toMatchObject({ phone_e164: "+919876543210", email: "asha@example.com", note: "window seat please", len: 90 * 60_000 });
  });
  it("chooses the smallest free table that fits (BR-10)", () => {
    const label = (ref: string) => (t.db.prepare("SELECT d.label FROM reservations r JOIN dining_tables d ON d.id = r.table_id WHERE r.ref = ?").get(ref) as { label: string }).label;
    const a = created(createReservation(t.db, body({ partySize: 2, phone: "9876500001" }), randomUUID(), NOW));
    const b = created(createReservation(t.db, body({ partySize: 2, phone: "9876500002" }), randomUUID(), NOW));
    const c = created(createReservation(t.db, body({ partySize: 2, phone: "9876500003" }), randomUUID(), NOW));
    expect([label(a.ref), label(b.ref), label(c.ref)]).toEqual(["T1", "T2", "T3"]);
  });

  it("replays the same key and body as 200 with the same booking and one row (AC-05, G-2)", () => {
    const key = randomUUID();
    const first = created(createReservation(t.db, body(), key, NOW));
    const again = createReservation(t.db, body({ phone: "+91 98765 43210" }), key, NOW + 5_000); // same number, other spelling
    expect(again).toMatchObject({ status: 200 });
    expect(created(again).ref).toBe(first.ref);
    expect(rows()).toBe(1);
  });
  it("reports a replay of a since-cancelled booking with its current status", () => {
    const key = randomUUID();
    const first = created(createReservation(t.db, body(), key, NOW));
    cancelReservation(t.db, first.ref, NOW + 1);
    expect(created(createReservation(t.db, body(), key, NOW + 2)).status).toBe("cancelled");
  });
  it("rejects the same key with a different body (422)", () => {
    const key = randomUUID();
    createReservation(t.db, body(), key, NOW);
    expect(createReservation(t.db, body({ partySize: 3 }), key, NOW)).toMatchObject({ code: "IDEMPOTENCY_MISMATCH", status: 422 });
    expect(rows()).toBe(1);
  });

  it("tells a returning guest about their own booking when the name matches (J7, AC-06, D-14)", () => {
    const first = created(createReservation(t.db, body({ startsAt: at("2026-10-17", "19:30") }), randomUUID(), NOW));
    const r = createReservation(t.db, body({ name: "  asha   RAO " }), randomUUID(), NOW);
    expect(r).toMatchObject({ code: "DUPLICATE_BOOKING", status: 409, existing: { ref: first.ref, branch: "hauz-khas", startsAt: at("2026-10-17", "19:30"), label: "7:30 PM", dateLabel: "Sat 17 Oct 2026" } });
    expect(rows()).toBe(1);
  });
  it("hides the existing booking from someone else using that mobile (D-14)", () => {
    createReservation(t.db, body({ startsAt: at("2026-10-17", "19:30") }), randomUUID(), NOW);
    expect(createReservation(t.db, body({ name: "Someone Else" }), randomUUID(), NOW)).toMatchObject({ code: "DUPLICATE_BOOKING", existing: null });
  });
  it("checks the guest before table choice: a guest holding the last fitting table hears about their booking", () => {
    // Party 7 → only T6 fits. Same guest, overlapping time.
    created(createReservation(t.db, body({ partySize: 7, startsAt: at("2026-10-17", "19:00") }), randomUUID(), NOW));
    expect(createReservation(t.db, body({ partySize: 7, startsAt: at("2026-10-17", "20:00") }), randomUUID(), NOW)).toMatchObject({ code: "DUPLICATE_BOOKING" });
  });
  it("allows the same mobile at the other branch and back-to-back at the same one", () => {
    created(createReservation(t.db, body({ startsAt: at("2026-10-17", "19:00") }), randomUUID(), NOW));
    expect(createReservation(t.db, body({ branch: "gurugram", startsAt: at("2026-10-17", "19:30") }), randomUUID(), NOW)).toMatchObject({ status: 201 });
    expect(createReservation(t.db, body({ startsAt: at("2026-10-17", "20:30") }), randomUUID(), NOW)).toMatchObject({ status: 201 });
  });

  it("returns SLOT_TAKEN with fresh alternatives when no fitting table is free", () => {
    for (const p of ["9800000001", "9800000002", "9800000003"]) created(createReservation(t.db, body({ phone: p }), randomUUID(), NOW)); // T3, T4, T5
    const r = createReservation(t.db, body({ phone: "9800000004" }), randomUUID(), NOW);
    expect(r).toMatchObject({ code: "SLOT_TAKEN", status: 409 });
    if ("alternatives" in r) {
      expect(r.alternatives.length).toBeGreaterThan(0);
      expect(r.alternatives.some((s) => s.branch === "hauz-khas" && s.startsAt === at("2026-10-17", "20:00"))).toBe(false);
      expect(r.alternatives.some((s) => s.branch === "gurugram")).toBe(true);
    }
    expect(rows()).toBe(3);
  });

  it.each([
    ["lead time (59 min ahead)", { startsAt: at("2026-10-16", "19:00") }, Date.parse("2026-10-16T18:01:00+05:30"), "lead_time"],
    ["in the past", { startsAt: at("2026-10-15", "19:00") }, NOW, "lead_time"],
    ["dinner closed on 22 Oct", { startsAt: at("2026-10-22", "20:00") }, NOW, "closed"],
    ["between services", { startsAt: at("2026-10-17", "16:00") }, NOW, "closed"],
    ["off the 30-minute grid", { startsAt: at("2026-10-17", "19:15") }, NOW, "off_grid"],
    ["after the last seating", { startsAt: at("2026-10-17", "22:00") }, NOW, "off_grid"],
    ["past the horizon", { startsAt: at("2026-11-16", "19:00") }, NOW, "past_horizon"],
    ["9 guests", { partySize: 9 }, NOW, "party_size"],
  ])("refuses %s with SLOT_UNAVAILABLE", (_label, over, now, reason) => {
    const r = createReservation(t.db, body(over), randomUUID(), now);
    expect(r).toMatchObject({ code: "SLOT_UNAVAILABLE", status: 409, reason });
    if ("alternatives" in r && reason !== "party_size" && reason !== "past_horizon" && reason !== "lead_time") expect(r.alternatives.length).toBeGreaterThan(0);
    expect(rows()).toBe(0);
  });
  it("offers the next open times at the boundary case (submit at now+59 min, AC review R4)", () => {
    const r = createReservation(t.db, body({ startsAt: at("2026-10-16", "19:00"), partySize: 2 }), randomUUID(), Date.parse("2026-10-16T18:01:00+05:30"));
    expect(r).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "lead_time" });
    if ("alternatives" in r) expect(r.alternatives[0]).toMatchObject({ branch: "hauz-khas", date: "2026-10-16", time: "19:30" });
  });
  it("refuses an inactive branch", () => {
    t.db.prepare("UPDATE branches SET is_active = 0 WHERE slug = 'gurugram'").run();
    expect(createReservation(t.db, body({ branch: "gurugram" }), randomUUID(), NOW)).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "branch_inactive" });
  });

  it.each([
    ["a landline", { phone: "011 4155 0101" }, "phone"],
    ["a short number", { phone: "98765 4321" }, "phone"],
    ["a foreign number", { phone: "+1 415 555 0100" }, "phone"],
    ["a 1-letter name", { name: " A " }, "name"],
    ["an 81-letter name", { name: "x".repeat(81) }, "name"],
    ["a bad email", { email: "asha@" }, "email"],
    ["a 301-character note", { note: "x".repeat(301) }, "note"],
    ["0 guests", { partySize: 0 }, "partySize"],
    ["an unknown branch", { branch: "noida" }, "branch"],
  ])("rejects %s with VALIDATION on that field (BR-09)", (_label, over, field) => {
    const r = createReservation(t.db, body(over), randomUUID(), NOW);
    expect(r).toMatchObject({ code: "VALIDATION", status: 400 });
    if ("fields" in r) expect(Object.keys(r.fields)).toContain(field);
    expect(rows()).toBe(0);
  });
  it("requires a UUID idempotency key", () => {
    expect(createReservation(t.db, body(), "not-a-uuid", NOW)).toMatchObject({ code: "VALIDATION", fields: { idempotencyKey: "must be a UUID" } });
  });

  it("regenerates a colliding booking reference instead of failing (R6)", () => {
    const first = created(createReservation(t.db, body({ phone: "9800000011" }), randomUUID(), NOW));
    const refs = [first.ref, first.ref, "NE-ZZZZZZZZ"];
    const r = createReservation(t.db, body({ phone: "9800000012" }), randomUUID(), NOW, { newRef: () => refs.shift()! });
    expect(r).toMatchObject({ status: 201 });
    expect(created(r).ref).toBe("NE-ZZZZZZZZ");
  });
  it("returns 503 UNAVAILABLE (nothing booked) when the database stays locked past the busy timeout", () => {
    const blocker = openDb(t.file);
    blocker.exec("BEGIN IMMEDIATE");
    const impatient = openDb(t.file, { timeoutMs: 150 });
    try {
      expect(createReservation(impatient, body(), randomUUID(), NOW)).toMatchObject({ code: "UNAVAILABLE", status: 503 });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
      impatient.close();
    }
    expect(rows()).toBe(0);
  });
});

describe("constraint-error mapping (D-08)", () => {
  // Defence in depth: inside one IMMEDIATE transaction the step-1 lookup always sees committed rows, so these
  // paths are reached only if a code path skips the checks. Real SqliteErrors are produced by raw inserts.
  const rawInsert = (o: { ref: string; key: string; table: string; phone: string; start: string; hash?: string }) => {
    try {
      t.db
        .prepare(`INSERT INTO reservations (id, ref, branch_id, table_id, guest_name, phone_e164, party_size, starts_at, ends_at, idempotency_key, request_hash, created_at)
          VALUES (?, ?, 1, (SELECT id FROM dining_tables WHERE branch_id = 1 AND label = ?), 'Asha Rao', ?, 4, ?, ?, ?, ?, 0)`)
        .run(randomUUID(), o.ref, o.table, o.phone, at("2026-10-17", o.start), at("2026-10-17", o.start) + 90 * 60_000, o.key, o.hash ?? "h");
      return null;
    } catch (e) {
      return e as { code: string; message: string };
    }
  };
  it("turns a same-key replay that hit GUEST_OVERLAP into a 200 replay (SQ-24)", () => {
    const key = randomUUID();
    const b = CreateBodySchema.parse(body());
    const first = created(createReservation(t.db, body(), key, NOW));
    const err = rawInsert({ ref: "NE-AAAAAAA1", key, table: "T4", phone: "+919876543210", start: "20:00" });
    expect(err).toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER", message: "GUEST_OVERLAP" });
    expect(mapConstraintError(t.db, err!, key, requestHash(b), b)).toEqual({ kind: "replayed", ref: first.ref });
    expect(mapConstraintError(t.db, err!, key, "other-hash", b)).toEqual({ kind: "mismatch" });
  });
  it("maps GUEST_OVERLAP and TABLE_OVERLAP for unknown keys, and rethrows anything else", () => {
    const b = CreateBodySchema.parse(body());
    const first = created(createReservation(t.db, body(), randomUUID(), NOW));
    const guest = rawInsert({ ref: "NE-AAAAAAA2", key: "k2", table: "T4", phone: "+919876543210", start: "20:00" })!;
    expect(mapConstraintError(t.db, guest, randomUUID(), "h", b)).toMatchObject({ kind: "duplicate", existing: { ref: first.ref } });
    const table = rawInsert({ ref: "NE-AAAAAAA3", key: "k3", table: (t.db.prepare("SELECT d.label FROM reservations r JOIN dining_tables d ON d.id = r.table_id WHERE r.ref = ?").get(first.ref) as { label: string }).label, phone: "+919800000077", start: "20:30" })!;
    expect(table).toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER", message: "TABLE_OVERLAP" });
    expect(mapConstraintError(t.db, table, randomUUID(), "h", b)).toEqual({ kind: "taken" });
    const check = rawInsert({ ref: "bad-ref", key: "k4", table: "T1", phone: "+919800000078", start: "12:00" })!;
    expect(check.code).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(() => mapConstraintError(t.db, check, randomUUID(), "h", b)).toThrow(/unmapped constraint error/);
  });
  it("hashes the normalised body", () => {
    const a = CreateBodySchema.parse(body({ name: " Asha  Rao ", phone: "+91 98765-43210", email: "ASHA@x.com" }));
    const b = CreateBodySchema.parse(body({ email: "asha@x.com" }));
    expect(requestHash(a)).toBe(requestHash(b));
  });
});

describe("cancel (BR-13)", () => {
  it("cancels idempotently and reopens the slot", () => {
    for (const p of ["9800000001", "9800000002", "9800000003"]) created(createReservation(t.db, body({ phone: p }), randomUUID(), NOW));
    const ref = (t.db.prepare("SELECT ref FROM reservations LIMIT 1").get() as { ref: string }).ref;
    const isOffered = () => {
      const r = getAvailability({ branch: "hauz-khas", date: "2026-10-17", partySize: 4, time: "20:00" }, loadAvailabilityData(t.db, ["2026-10-17"]), NOW);
      return r.ok && r.slots.some((s) => s.time === "20:00");
    };
    expect(isOffered()).toBe(false);
    expect(cancelReservation(t.db, ref, NOW + 1)).toMatchObject({ status: 200, changed: true, reservation: { status: "cancelled", cancelledAt: NOW + 1 } });
    expect(cancelReservation(t.db, ref, NOW + 2)).toMatchObject({ status: 200, changed: false, reservation: { cancelledAt: NOW + 1 } });
    expect(isOffered()).toBe(true);
    expect(createReservation(t.db, body({ phone: "9800000004" }), randomUUID(), NOW)).toMatchObject({ status: 201 });
  });
  it("returns NOT_FOUND for an unknown ref", () => {
    expect(cancelReservation(t.db, "NE-00000000", NOW)).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("review regressions (T-03..T-07)", () => {
  it("BI-1: a blank optional email books with email NULL and hashes like no email", () => {
    for (const email of ["", "   "]) {
      const r = createReservation(t.db, body({ email, phone: email ? "9800000031" : "9800000032" }), randomUUID(), NOW);
      expect(r).toMatchObject({ status: 201 });
    }
    expect((t.db.prepare("SELECT count(*) AS n FROM reservations WHERE email IS NULL").get() as { n: number }).n).toBe(2);
    expect(requestHash(CreateBodySchema.parse(body({ email: "  " })))).toBe(requestHash(CreateBodySchema.parse(body({ email: null }))));
  });
  it.each([["a\u0000"], ["ab\u0000cd"], ["​​"], ["Asha‮Rao"], ["12"], ["--"]])("BI-2: rejects name %j", (name) => {
    expect(createReservation(t.db, body({ name }), randomUUID(), NOW)).toMatchObject({ code: "VALIDATION", fields: { name: expect.any(String) } });
  });
  it.each([["O'Brien"], ["Lí Wei"], ["आशा राव"], ["Jo"]])("BI-2: accepts name %j", (name) => {
    expect(createReservation(t.db, body({ name }), randomUUID(), NOW)).toMatchObject({ status: 201 });
  });
  it.each([[9e15], [3e14], [-1e14], [0]])("BI-3: rejects startsAt %s with VALIDATION", (startsAt) => {
    expect(createReservation(t.db, body({ startsAt }), randomUUID(), NOW)).toMatchObject({ code: "VALIDATION", fields: { startsAt: expect.any(String) } });
  });
  it("BI-4: finds the guest's own booking among several on a shared mobile", () => {
    const ravi = created(createReservation(t.db, body({ name: "Ravi Rao", startsAt: at("2026-10-17", "19:00") }), randomUUID(), NOW));
    const asha = created(createReservation(t.db, body({ name: "Asha Rao", startsAt: at("2026-10-17", "20:30") }), randomUUID(), NOW));
    expect(createReservation(t.db, body({ name: "Asha Rao", startsAt: at("2026-10-17", "20:00") }), randomUUID(), NOW)).toMatchObject({ code: "DUPLICATE_BOOKING", existing: { ref: asha.ref } });
    expect(createReservation(t.db, body({ name: "Ravi Rao", startsAt: at("2026-10-17", "20:00") }), randomUUID(), NOW)).toMatchObject({ code: "DUPLICATE_BOOKING", existing: { ref: ravi.ref } });
  });
  it("BI-5: an upper-case spelling of the same key replays the booking", () => {
    const key = randomUUID();
    const first = created(createReservation(t.db, body(), key, NOW));
    const again = createReservation(t.db, body(), key.toUpperCase(), NOW);
    expect(again).toMatchObject({ status: 200 });
    expect(created(again).ref).toBe(first.ref);
    expect(rows()).toBe(1);
  });
  it("AV-2: an inactive branch still offers the other branch's times", () => {
    t.db.prepare("UPDATE branches SET is_active = 0 WHERE slug = 'gurugram'").run();
    const r = createReservation(t.db, body({ branch: "gurugram" }), randomUUID(), NOW);
    expect(r).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "branch_inactive" });
    if ("alternatives" in r) {
      expect(r.alternatives.length).toBeGreaterThan(0);
      expect(r.alternatives.every((s) => s.branch === "hauz-khas")).toBe(true);
    }
  });
  it("AV-3: re-validates on the branch's own calendar date when its zone differs from IST", () => {
    const ny = { ...seed, branches: seed.branches.map((b) => (b.slug === "gurugram" ? { ...b, timezone: "America/New_York" } : b)), exceptions: [...seed.exceptions, { branch: "gurugram", date: "2026-10-20", service: null, isClosed: true, opens: null, closes: null, note: "Closed" }] };
    const u = tempDb("booking-ny");
    try {
      applySeed(u.db, ny, { now: NOW });
      const r = createReservation(u.db, body({ branch: "gurugram", startsAt: toInstant("2026-10-20", "19:00", "America/New_York") }), randomUUID(), NOW);
      expect(r).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "closed" });
    } finally {
      u.cleanup();
    }
  });
});
