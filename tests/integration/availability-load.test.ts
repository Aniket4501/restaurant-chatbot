import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAvailability, type AvailabilityQuery } from "@/lib/booking/availability";
import { loadAvailabilityData } from "@/lib/booking/load";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { toInstant } from "@/lib/time/tz";
import { bookingAt, fixtureBundle } from "../helpers/bundle";
import { tempDb } from "./helpers/db";

const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));
let t: ReturnType<typeof tempDb>;
beforeEach(() => {
  t = tempDb("avail");
  applySeed(t.db, seed, { now: NOW });
});
afterEach(() => t.cleanup());

function insert(ref: string, branch: string, label: string, date: string, time: string, party: number, status: "confirmed" | "cancelled", phone: string) {
  const ids = t.db.prepare("SELECT b.id AS b, d.id AS d FROM branches b JOIN dining_tables d ON d.branch_id = b.id WHERE b.slug = ? AND d.label = ?").get(branch, label) as { b: number; d: number };
  const start = toInstant(date, time, "Asia/Kolkata");
  t.db
    .prepare(`INSERT INTO reservations (id, ref, branch_id, table_id, guest_name, phone_e164, party_size, starts_at, ends_at, status, idempotency_key, request_hash, created_at)
      VALUES (?, ?, ?, ?, 'Asha', ?, ?, ?, ?, ?, ?, 'h', 0)`)
    .run(ref, ref, ids.b, ids.d, phone, party, start, start + (party <= 4 ? 90 : 120) * 60_000, status, `k-${ref}`);
}

const QUERIES: AvailabilityQuery[] = [
  { branch: "hauz-khas", date: "2026-10-17", partySize: 4, time: "20:00" },
  { branch: "hauz-khas", date: "2026-10-22", partySize: 2, time: "20:00" },
  { branch: "gurugram", date: "2026-10-27", partySize: 4 },
  { branch: "gurugram", date: "2026-10-19", partySize: 2, window: "lunch" },
  { branch: "hauz-khas", date: "2026-10-31", partySize: 6, window: "dinner" },
];

describe("loadAvailabilityData", () => {
  it("gives the same answers as the fixture bundle, counting confirmed bookings only", () => {
    insert("NE-AAAAAAA1", "hauz-khas", "T3", "2026-10-17", "20:00", 4, "confirmed", "+919800000001");
    insert("NE-AAAAAAA2", "hauz-khas", "T4", "2026-10-17", "20:00", 4, "confirmed", "+919800000002");
    insert("NE-AAAAAAA3", "hauz-khas", "T5", "2026-10-17", "20:00", 4, "cancelled", "+919800000003");
    const expected = fixtureBundle();
    expected.bookings.push(bookingAt(expected, "hauz-khas", "T3", "2026-10-17", "20:00", 4), bookingAt(expected, "hauz-khas", "T4", "2026-10-17", "20:00", 4));
    for (const q of QUERIES) {
      const fromDb = getAvailability(q, loadAvailabilityData(t.db, [q.date]), NOW);
      expect(fromDb, JSON.stringify(q)).toEqual(getAvailability(q, expected, NOW));
    }
  });
  it("loads bookings for the alternative days too", () => {
    insert("NE-AAAAAAA4", "hauz-khas", "T6", "2026-10-18", "19:00", 8, "confirmed", "+919800000004");
    const bundle = loadAvailabilityData(t.db, ["2026-10-16"]);
    expect(bundle.bookings).toHaveLength(1);
  });
});
