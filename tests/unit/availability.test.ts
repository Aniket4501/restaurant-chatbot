import { describe, expect, it } from "vitest";
import { getAvailability, isOpenStart, openStarts, pickTable, type AvailabilityResult, type Slot } from "@/lib/booking/availability";
import { toInstant } from "@/lib/time/tz";
import { bookingAt, fixtureBundle } from "../helpers/bundle";

// Table-driven fixtures for MASTER_PROMPT §5.5 against evals/fixtures/base.json.
// Default now = Fri 16 Oct 2026, 2:00 PM IST. Availability accuracy must be 100% (§6.5).
const IST = "Asia/Kolkata";
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const at = (date: string, time: string) => toInstant(date, time, IST);
const times = (slots: Slot[]) => slots.map((s) => s.time);
const where = (slots: Slot[]) => slots.map((s) => `${s.branch} ${s.date} ${s.time}`);
function ok(r: AvailabilityResult) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r;
}

describe("weekly hours, grid and last seating (BR-02, BR-04, BR-05)", () => {
  it("offers up to 3 per service with no preference", () => {
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-17", partySize: 4 }, fixtureBundle(), NOW));
    expect(times(r.slots)).toEqual(["12:00", "12:30", "13:00", "19:00", "19:30", "20:00"]);
    expect(r.reason).toBeNull();
    expect(r.alternatives).toEqual([]);
    expect(r.sittingMinutes).toBe(90);
    expect(r.slots[0]).toMatchObject({ label: "12:00 PM", service: "lunch", startsAt: at("2026-10-17", "12:00"), endsAt: at("2026-10-17", "13:30") });
  });
  it("ends seating at close minus sitting time: 90 min for 1–4, 120 min for 5–8", () => {
    const b = fixtureBundle();
    const hk = b.branches[0];
    expect(times(openStarts(b, hk, "2026-10-17", 4, NOW).open)).toEqual(["12:00", "12:30", "13:00", "13:30", "14:00", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30"]);
    expect(times(openStarts(b, hk, "2026-10-17", 6, NOW).open)).toEqual(["12:00", "12:30", "13:00", "13:30", "19:00", "19:30", "20:00", "20:30", "21:00"]);
  });
  it("keeps Gurugram closed for Monday lunch and falls back to the day's other times (BR-08)", () => {
    const r = ok(getAvailability({ branch: "gurugram", date: "2026-10-19", partySize: 2, window: "lunch" }, fixtureBundle(), NOW));
    expect(r.matchedWindow).toBe(false);
    expect(times(r.slots)).toEqual(["19:00", "19:30", "20:00", "20:30", "21:00", "21:30"]);
    expect(where(r.alternatives)).toEqual([
      "hauz-khas 2026-10-19 12:00", "hauz-khas 2026-10-19 12:30", "hauz-khas 2026-10-19 13:00",
      "gurugram 2026-10-20 12:00", "gurugram 2026-10-20 12:30", "gurugram 2026-10-20 13:00",
    ]);
  });
  it("returns the first 6 in a requested window", () => {
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-17", partySize: 2, window: "dinner" }, fixtureBundle(), NOW));
    expect(r.matchedWindow).toBe(true);
    expect(times(r.slots)).toEqual(["19:00", "19:30", "20:00", "20:30", "21:00", "21:30"]);
  });
  it("returns the 6 nearest to a preferred time, in time order", () => {
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-17", partySize: 2, time: "20:00" }, fixtureBundle(), NOW));
    expect(times(r.slots)).toEqual(["19:00", "19:30", "20:00", "20:30", "21:00", "21:30"]);
    expect(r.alternatives).toEqual([]);
  });
});

describe("date exceptions replace weekly hours (§5.5 step 2)", () => {
  it("22 Oct: Hauz Khas dinner closed, lunch open; 8 PM gets alternatives", () => {
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-22", partySize: 2, time: "20:00" }, fixtureBundle(), NOW));
    expect(times(r.slots)).toEqual(["12:00", "12:30", "13:00", "13:30", "14:00"]);
    expect(r.reason).toBeNull();
    expect(where(r.alternatives)).toEqual([
      "gurugram 2026-10-22 19:30", "gurugram 2026-10-22 20:00", "gurugram 2026-10-22 20:30",
      "hauz-khas 2026-10-23 19:30", "hauz-khas 2026-10-23 20:00", "hauz-khas 2026-10-23 20:30",
    ]);
  });
  it("27 Oct: Gurugram closed all day", () => {
    const r = ok(getAvailability({ branch: "gurugram", date: "2026-10-27", partySize: 4 }, fixtureBundle(), NOW));
    expect(r.slots).toEqual([]);
    expect(r.reason).toBe("closed");
    expect(where(r.alternatives)).toEqual([
      "hauz-khas 2026-10-27 12:00", "hauz-khas 2026-10-27 12:30", "hauz-khas 2026-10-27 13:00",
      "gurugram 2026-10-28 12:00", "gurugram 2026-10-28 12:30", "gurugram 2026-10-28 13:00",
    ]);
  });
  it("31 Oct: extended dinner to 11:30 PM moves the last seating to 10:00 PM", () => {
    const b = fixtureBundle();
    const dinner = openStarts(b, b.branches[0], "2026-10-31", 4, NOW).open.filter((s) => s.service === "dinner");
    expect(times(dinner)).toEqual(["19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00"]);
  });
});

describe("lead time and horizon (BR-06)", () => {
  it.each([
    ["17:59", "19:00"],
    ["18:00", "19:00"],
    ["18:01", "19:30"],
  ])("now %s → first slot %s (60-minute lead time)", (nowTime, first) => {
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-16", partySize: 2, window: "dinner" }, fixtureBundle(), at("2026-10-16", nowTime)));
    expect(r.slots[0].time).toBe(first);
  });
  it("reports no_more_today late in the evening and offers the next day", () => {
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-16", partySize: 2 }, fixtureBundle(), at("2026-10-16", "22:30")));
    expect(r.slots).toEqual([]);
    expect(r.reason).toBe("no_more_today");
    expect(where(r.alternatives)).toEqual(["hauz-khas 2026-10-17 12:00", "hauz-khas 2026-10-17 12:30", "hauz-khas 2026-10-17 13:00"]);
  });
  it("accepts today + 30 days and rejects day 31 and the past", () => {
    const b = fixtureBundle();
    expect(getAvailability({ branch: "hauz-khas", date: "2026-11-15", partySize: 2 }, b, NOW).ok).toBe(true);
    expect(getAvailability({ branch: "hauz-khas", date: "2026-11-16", partySize: 2 }, b, NOW)).toEqual({ ok: false, error: "past_horizon" });
    expect(getAvailability({ branch: "hauz-khas", date: "2026-10-15", partySize: 2 }, b, NOW)).toEqual({ ok: false, error: "past_date" });
    expect(getAvailability({ branch: "hauz-khas", date: "2026-02-30", partySize: 2 }, b, NOW)).toEqual({ ok: false, error: "invalid_date" });
  });
  it("drops alternatives past the horizon", () => {
    const b = fixtureBundle();
    b.bookings.push(bookingAt(b, "hauz-khas", "T6", "2026-11-15", "19:00", 8)); // only T6 fits 8
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-11-15", partySize: 8, time: "19:00" }, b, NOW));
    expect(r.alternatives.every((a) => a.date === "2026-11-15")).toBe(true);
  });
});

describe("validation (BR-07)", () => {
  it.each([
    [9, "party_too_large"],
    [12, "party_too_large"],
    [0, "party_size"],
    [2.5, "party_size"],
  ])("party %s → %s", (party, error) => {
    expect(getAvailability({ branch: "hauz-khas", date: "2026-10-17", partySize: party }, fixtureBundle(), NOW)).toEqual({ ok: false, error });
  });
  it("rejects unknown and inactive branches", () => {
    expect(getAvailability({ branch: "noida", date: "2026-10-17", partySize: 2 }, fixtureBundle(), NOW)).toEqual({ ok: false, error: "unknown_branch" });
    expect(getAvailability({ branch: "gurugram", date: "2026-10-17", partySize: 2 }, fixtureBundle({ inactiveBranches: ["gurugram"] }), NOW)).toEqual({ ok: false, error: "branch_inactive" });
  });
  it("skips an inactive branch when offering alternatives", () => {
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-22", partySize: 2, time: "20:00" }, fixtureBundle({ inactiveBranches: ["gurugram"] }), NOW));
    expect(r.alternatives.every((a) => a.branch === "hauz-khas")).toBe(true);
  });
});

describe("existing bookings (AC-03, J4)", () => {
  it("BK-UNAVAIL-001: 8 PM for 4 at Hauz Khas is full, other times and alternatives are offered", () => {
    const b = fixtureBundle();
    for (const label of ["T3", "T4", "T5"]) b.bookings.push(bookingAt(b, "hauz-khas", label, "2026-10-17", "20:00", 4));
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-17", partySize: 4, time: "20:00" }, b, NOW));
    expect(times(r.slots)).not.toContain("20:00");
    expect(times(r.slots)).toEqual(["12:00", "12:30", "13:00", "13:30", "14:00", "21:30"]);
    expect(where(r.alternatives)).toEqual([
      "gurugram 2026-10-17 19:30", "gurugram 2026-10-17 20:00", "gurugram 2026-10-17 20:30",
      "hauz-khas 2026-10-18 19:30", "hauz-khas 2026-10-18 20:00", "hauz-khas 2026-10-18 20:30",
    ]);
  });
  it("reports fully_booked when every fitting table is taken all day", () => {
    const b = fixtureBundle();
    for (const time of ["12:00", "14:00", "19:00", "21:00"]) b.bookings.push(bookingAt(b, "hauz-khas", "T6", "2026-10-18", time, 8));
    const r = ok(getAvailability({ branch: "hauz-khas", date: "2026-10-18", partySize: 7 }, b, NOW));
    expect(r.slots).toEqual([]);
    expect(r.reason).toBe("fully_booked");
    expect(r.alternatives.length).toBeGreaterThan(0);
  });
  it("treats sittings as half-open intervals", () => {
    const b = fixtureBundle();
    b.bookings.push(bookingAt(b, "hauz-khas", "T6", "2026-10-17", "19:00", 8)); // 19:00–21:00
    const hk = b.branches[0];
    expect(isOpenStart(b, hk, "2026-10-17", 7, at("2026-10-17", "21:00"), NOW)).toBe(true);
    expect(isOpenStart(b, hk, "2026-10-17", 7, at("2026-10-17", "20:30"), NOW)).toBe(false);
    expect(isOpenStart(b, hk, "2026-10-17", 7, at("2026-10-17", "19:15"), NOW)).toBe(false); // off the grid
  });
});

describe("table choice (BR-10)", () => {
  const start = at("2026-10-17", "19:00");
  const end = start + 90 * 60_000;
  it.each([
    [1, "T1"],
    [2, "T1"],
    [3, "T3"],
    [4, "T3"],
    [5, "T5"],
    [6, "T5"],
    [7, "T6"],
    [8, "T6"],
  ])("party %s → %s", (party, label) => {
    const b = fixtureBundle();
    expect(pickTable(b, 1, party, start, end)?.label).toBe(label);
  });
  it("moves to the next smallest table when one is taken, and returns null when none fits", () => {
    const b = fixtureBundle();
    b.bookings.push(bookingAt(b, "hauz-khas", "T1", "2026-10-17", "19:00", 2), bookingAt(b, "hauz-khas", "T2", "2026-10-17", "19:00", 2));
    expect(pickTable(b, 1, 2, start, end)?.label).toBe("T3");
    b.bookings.push(bookingAt(b, "hauz-khas", "T3", "2026-10-17", "19:00", 2), bookingAt(b, "hauz-khas", "T4", "2026-10-17", "19:00", 2));
    expect(pickTable(b, 1, 2, start, end)).toBeNull(); // T5 (4–6) and T6 (6–8) don't fit 2
  });
});
