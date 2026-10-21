import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { availabilityDayHandler, blockHandlers, bookingItemHandlers, bookingsListHandler, branchAvailabilityHandler, branchItemHandler, branchesHandler, overviewHandler, restaurantHandler, specialDateHandlers, tableHandlers, tableItemHandlers, weeklyHoursHandler } from "@/lib/api/admin-workspace";
import { getAvailability } from "@/lib/booking/availability";
import { createReservation } from "@/lib/booking/create";
import { loadAvailabilityData } from "@/lib/booking/load";
import { noTurnLimit } from "@/lib/chat/ratelimit";
import { runTurn } from "@/lib/chat/turn";
import { applySeed } from "@/lib/db/seed";
import { fakeEmbedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts, renderStaticFacts } from "@/lib/kb/facts";
import { lexicalCurrent } from "@/lib/kb/index";
import { fakeModel } from "@/lib/llm/fake";
import { toInstant } from "@/lib/time/tz";
import { call, SEED, seeded } from "./helpers/admin";

// D-25 availability, branches and bookings: the admin edits the rows the availability engine reads, its views come
// from the engine, and the chatbot, the public availability API and the booking write path all follow at once.
const NOW = Date.parse("2026-10-16T14:00:00+05:30"); // Fri 16 Oct, 2 PM IST
const IST = "Asia/Kolkata";
let s: Awaited<ReturnType<typeof seeded>>;
beforeEach(async () => {
  s = await seeded("admin-avail", NOW);
});
afterEach(() => s.t.cleanup());

const db = () => s.t.db;
const at = (date: string, time: string) => toInstant(date, time, IST);
const book = (date: string, time: string, party: number, phone: string, branch = "hauz-khas", key = randomUUID()) =>
  createReservation(db(), { branch, startsAt: at(date, time), partySize: party, name: `Guest ${phone.slice(-2)}`, phone, email: `g${phone.slice(-2)}@example.com`, note: "window seat" }, key, NOW);
const slots = (branch: string, date: string, party: number) => {
  const r = getAvailability({ branch, date, partySize: party }, loadAvailabilityData(db(), [date]), NOW);
  return r.ok ? r : null;
};
const openAt = (branch: string, date: string, party: number, time: string) => {
  const r = getAvailability({ branch, date, partySize: party, time }, loadAvailabilityData(db(), [date]), NOW);
  return r.ok && r.slots.some((x) => x.time === time);
};
const day = async (branch: string, date: string, party = 2) => (await call(availabilityDayHandler(s.deps), "GET", `/api/admin/availability?branch=${branch}&date=${date}&party=${party}`)).json;
const staticText = (id: string) => renderStaticFacts(loadFactSource(db()), NOW).find((f) => f.id === id)?.text ?? null;
const WEEK = [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ weekday, lunch: { opens: "12:00", closes: "15:30" }, dinner: { opens: "19:00", closes: "23:00" } }));

describe("day view (D-25)", () => {
  it("shows every start with the engine's own status, in the branch time zone", async () => {
    const d = await day("hauz-khas", "2026-10-16");
    expect(d).toMatchObject({ today: "2026-10-16", dateLabel: "Fri 16 Oct 2026", bookable: { ok: true }, hours: { source: "weekly" } });
    expect(d.starts.filter((x: { service: string }) => x.service === "lunch").every((x: { status: string }) => x.status === "lead_time")).toBe(true); // 2 PM now + 60 min lead
    expect(d.starts.filter((x: { service: string }) => x.service === "dinner").map((x: { time: string; status: string }) => `${x.time} ${x.status}`)).toEqual(["19:00 open", "19:30 open", "20:00 open", "20:30 open", "21:00 open", "21:30 open"]);
    expect(d.tables.map((t: { label: string }) => t.label)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    expect((await day("hauz-khas", "2026-10-15")).bookable).toEqual({ ok: false, reason: "This date is in the past." });
    expect((await day("hauz-khas", "2026-11-20")).bookable.reason).toMatch(/up to 30 days ahead/);
    // Just after midnight IST it is already the 17th there, though still the 16th in UTC.
    s.setNow(Date.parse("2026-10-17T00:30:00+05:30"));
    expect((await day("hauz-khas", "2026-10-17")).today).toBe("2026-10-17");
  });

  it("counts bookings per table and per start", async () => {
    const r = book("2026-10-17", "20:00", 7, "9800000001");
    expect(r.status).toBe(201);
    const d = await day("hauz-khas", "2026-10-17", 7);
    expect(d.summary).toMatchObject({ bookings: 1, covers: 7 });
    expect(d.tables.find((t: { label: string }) => t.label === "T6").bookings).toMatchObject([{ partySize: 7, startLabel: "8:00 PM", endLabel: "10:00 PM" }]);
    const eight = d.starts.find((x: { time: string }) => x.time === "20:00");
    expect(eight).toMatchObject({ status: "full", fittingTables: 1, freeTables: 0, startingHere: 1 });
  });
});

describe("slot blocks (D-25)", () => {
  const blocks = () => blockHandlers(s.deps);
  it("a blocked start is offered nowhere and refused by the booking write path; reopening restores it", async () => {
    const r = await call(blocks().POST, "POST", "/api/admin/branches/hauz-khas/blocks/2026-10-17", { times: ["20:00"], reason: "Staff training" }, { slug: "hauz-khas", date: "2026-10-17" });
    expect(r.json).toEqual({ added: ["20:00"], already: [], bookingsAtTimes: 0 });
    expect(openAt("hauz-khas", "2026-10-17", 2, "20:00")).toBe(false);
    expect(openAt("hauz-khas", "2026-10-17", 2, "20:30")).toBe(true);
    expect((await day("hauz-khas", "2026-10-17")).starts.find((x: { time: string }) => x.time === "20:00")).toMatchObject({ status: "blocked", blockReason: "Staff training" });
    const refused = book("2026-10-17", "20:00", 2, "9800000002");
    expect(refused).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "blocked" });
    // The chatbot: tapping a blocked time (a chip shown before the block) gets fresh times instead of a confirm card.
    const tap = await runTurn(
      { now: NOW, sessionId: randomUUID(), messages: [], draft: { branch: "hauz-khas", date: "2026-10-17", time: null, timeWindow: null, partySize: 2, selected: null }, action: { type: "select_slot", branch: "hauz-khas", startsAt: at("2026-10-17", "20:00") } },
      { db: db(), model: fakeModel(), embedder: fakeEmbedder(), limiter: noTurnLimit },
    );
    expect(tap.meta.outcome).toBe("slots");
    expect(JSON.stringify(tap.reply.blocks)).not.toContain(String(at("2026-10-17", "20:00")));
    expect((await call(blocks().POST, "POST", "/api/admin/branches/hauz-khas/blocks/2026-10-17", { times: ["20:00"] }, { slug: "hauz-khas", date: "2026-10-17" })).json.already).toEqual(["20:00"]);
    expect((await call(blocks().DELETE, "DELETE", "/api/admin/branches/hauz-khas/blocks/2026-10-17", { times: ["20:00"] }, { slug: "hauz-khas", date: "2026-10-17" })).json).toEqual({ removed: ["20:00"] });
    expect(openAt("hauz-khas", "2026-10-17", 2, "20:00")).toBe(true);
    expect(book("2026-10-17", "20:00", 2, "9800000002").status).toBe(201);
  });

  it("blocking every dinner start reads as fully booked to guests, not closed", async () => {
    await call(blocks().POST, "POST", "/api/admin/branches/hauz-khas/blocks/2026-10-16", { times: ["19:00", "19:30", "20:00", "20:30", "21:00", "21:30"] }, { slug: "hauz-khas", date: "2026-10-16" });
    expect(slots("hauz-khas", "2026-10-16", 2)).toMatchObject({ slots: [], reason: "fully_booked" });
  });

  it("refuses times off the grid, outside the hours, and dates in the past; says how many bookings a block leaves in place", async () => {
    const post = (date: string, times: string[]) => call(blocks().POST, "POST", `/api/admin/branches/hauz-khas/blocks/${date}`, { times }, { slug: "hauz-khas", date });
    expect((await post("2026-10-17", ["20:15"])).json.error.fields.times).toMatch(/isn't a booking time/);
    expect((await post("2026-10-17", ["17:00"])).json.error.fields.times).toMatch(/isn't a booking time/);
    expect((await post("2026-10-15", ["20:00"])).json.error.fields.date).toMatch(/in the past/);
    expect((await post("2026-10-17", [])).status).toBe(400);
    book("2026-10-17", "19:00", 2, "9800000003");
    expect((await post("2026-10-17", ["19:00"])).json.bookingsAtTimes).toBe(1);
    expect(db().prepare("SELECT status FROM reservations").all()).toEqual([{ status: "confirmed" }]);
  });
});

describe("weekly hours and special dates (D-25)", () => {
  const putWeek = (days: unknown, confirm?: boolean) => call(weeklyHoursHandler(s.deps), "PUT", "/api/admin/branches/hauz-khas/hours", { days, ...(confirm ? { confirm } : {}) }, { slug: "hauz-khas" });

  it("new hours reach the chatbot's hours facts and the engine at once", async () => {
    const days = WEEK.map((d) => (d.weekday === 6 ? { ...d, dinner: { opens: "18:00", closes: "23:30" } } : d));
    const r = await putWeek(days);
    expect(r.status).toBe(200);
    expect(r.json.summary).toBe("Sat lunch 12:00–15:30, dinner 18:00–23:30");
    expect(staticText("hours:hauz-khas:sat")).toContain("dinner 6:00 PM–11:30 PM");
    expect(openAt("hauz-khas", "2026-10-17", 2, "18:00")).toBe(true);
    expect(db().prepare("SELECT area, action FROM admin_changes").all()).toEqual([{ area: "hours", action: "weekly hours" }]);
  });

  it("refuses hours that would strand a confirmed booking unless staff confirm, and then keeps the booking", async () => {
    const r = book("2026-10-17", "20:00", 4, "9800000004");
    if (!("reservation" in r)) throw new Error("booking failed");
    const short = WEEK.map((d) => (d.weekday === 6 ? { ...d, dinner: { opens: "19:00", closes: "21:00" } } : d));
    const refused = await putWeek(short);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: "CONFLICT", conflicts: [{ ref: r.reservation.ref, dateLabel: "Sat 17 Oct 2026", timeLabel: "8:00 PM", reason: "would be outside the opening hours" }] });
    expect(staticText("hours:hauz-khas:sat")).toContain("dinner 7:00 PM–11:00 PM"); // nothing saved
    const ok = await putWeek(short, true);
    expect(ok.json.accepted.map((c: { ref: string }) => c.ref)).toEqual([r.reservation.ref]);
    expect(db().prepare("SELECT status FROM reservations").get()).toEqual({ status: "confirmed" });
    const o = (await call(overviewHandler(s.deps), "GET", "/api/admin/overview")).json;
    expect(o.warnings[0]).toMatchObject({ tone: "bad", title: "1 upcoming booking doesn't fit the current hours or tables" });
  });

  it("validates windows: closing after opening, long enough for a sitting, no lunch–dinner overlap, all seven days", async () => {
    const one = (patch: object) => WEEK.map((d) => (d.weekday === 1 ? { ...d, ...patch } : d));
    expect((await putWeek(one({ lunch: { opens: "15:00", closes: "12:00" } }))).status).toBe(400);
    expect(JSON.stringify((await putWeek(one({ lunch: { opens: "12:00", closes: "13:00" } }))).json)).toMatch(/at least 1 h 30 min/);
    expect((await putWeek(one({ lunch: { opens: "12:00", closes: "20:00" } }))).json.error.message).toMatch(/overlap on Monday/);
    expect((await putWeek(WEEK.slice(1))).status).toBe(400);
    expect((await putWeek(one({ lunch: null }))).status).toBe(200); // closed for Monday lunch is fine
  });

  it("special dates: closed all day, or each service open or closed; the chatbot's exception facts follow", async () => {
    const special = specialDateHandlers(s.deps);
    const put = (date: string, body: object) => call(special.PUT, "PUT", `/api/admin/branches/gurugram/special-dates/${date}`, body, { slug: "gurugram", date });
    expect((await put("2026-10-18", { closedAllDay: true, lunch: null, dinner: null, note: "Diwali" })).status).toBe(200);
    expect(slots("gurugram", "2026-10-18", 2)).toMatchObject({ slots: [], reason: "closed" });
    expect(staticText("exception:gurugram:2026-10-18")).toBe("Golf Course Road on Sun 18 Oct 2026 (special hours replacing the usual ones): closed all day (Diwali).");
    expect((await put("2026-10-19", { closedAllDay: false, lunch: null, dinner: { opens: "19:00", closes: "23:30" }, note: null })).status).toBe(200);
    expect(db().prepare("SELECT service, is_closed FROM hours_exceptions WHERE date = '2026-10-19' ORDER BY service").all()).toEqual([{ service: "dinner", is_closed: 0 }, { service: "lunch", is_closed: 1 }]);
    expect(openAt("gurugram", "2026-10-19", 2, "22:00")).toBe(true);
    expect((await put("2026-10-20", { closedAllDay: false, lunch: null, dinner: null, note: null })).status).toBe(200);
    expect(db().prepare("SELECT service FROM hours_exceptions WHERE date = '2026-10-20'").all()).toEqual([{ service: null }]); // both closed = whole day
    expect((await put("2026-10-15", { closedAllDay: true, lunch: null, dinner: null, note: null })).json.error.fields.date).toMatch(/in the past/);
    expect((await put("2026-10-21", { closedAllDay: false, lunch: { opens: "12:00", closes: "20:00" }, dinner: { opens: "19:00", closes: "23:00" }, note: null })).status).toBe(400);
    const del = await call(special.DELETE, "DELETE", "/api/admin/branches/gurugram/special-dates/2026-10-18", undefined, { slug: "gurugram", date: "2026-10-18" });
    expect(del.status).toBe(200);
    expect(staticText("exception:gurugram:2026-10-18")).toBeNull();
    expect(openAt("gurugram", "2026-10-18", 2, "20:00")).toBe(true);
    const list = (await call(branchAvailabilityHandler(s.deps), "GET", "/api/admin/branches/gurugram/availability", undefined, { slug: "gurugram" })).json;
    expect(list.specialDates.map((d: { date: string; closedAllDay: boolean }) => `${d.date} ${d.closedAllDay}`)).toEqual(["2026-10-19 false", "2026-10-20 true", "2026-10-27 true"]);
    expect(list.rules).toMatchObject({ slotMinutes: 30, sittingSmall: 90, sittingLarge: 120, leadMinutes: 60, horizonDays: 30, partyMax: 8 });
  });
});

describe("tables (D-25)", () => {
  it("adding a table adds capacity at once; taking the only 8-top away needs confirmation and leaves its booking", async () => {
    const before = (await day("hauz-khas", "2026-10-17", 3)).starts.find((x: { time: string }) => x.time === "20:00");
    const add = await call(tableHandlers(s.deps).POST, "POST", "/api/admin/branches/hauz-khas/tables", { label: "T7", minSeats: 2, maxSeats: 4 }, { slug: "hauz-khas" });
    expect(add.status).toBe(201);
    const after = (await day("hauz-khas", "2026-10-17", 3)).starts.find((x: { time: string }) => x.time === "20:00");
    expect(after.fittingTables).toBe(before.fittingTables + 1);
    expect((await call(tableHandlers(s.deps).POST, "POST", "/api/admin/branches/hauz-khas/tables", { label: "t7", minSeats: 2, maxSeats: 4 }, { slug: "hauz-khas" })).status).toBe(409);
    expect((await call(tableHandlers(s.deps).POST, "POST", "/api/admin/branches/hauz-khas/tables", { label: "T8", minSeats: 5, maxSeats: 4 }, { slug: "hauz-khas" })).json.error.fields.maxSeats).toBeDefined();
    const r = book("2026-10-17", "20:00", 7, "9800000005");
    if (!("reservation" in r)) throw new Error("booking failed");
    const t6 = (db().prepare("SELECT id FROM dining_tables WHERE label = 'T6' AND branch_id = (SELECT id FROM branches WHERE slug = 'hauz-khas')").get() as { id: number }).id;
    const patch = (body: object) => call(tableItemHandlers(s.deps).PATCH, "PATCH", `/api/admin/branches/hauz-khas/tables/${t6}`, body, { slug: "hauz-khas", id: String(t6) });
    expect((await patch({ isActive: false })).json.error).toMatchObject({ code: "CONFLICT", conflicts: [{ ref: r.reservation.ref, reason: "is on a table or branch that would be inactive" }] });
    expect((await patch({ isActive: false, confirm: true })).json.accepted).toHaveLength(1);
    expect(slots("hauz-khas", "2026-10-18", 7)).toMatchObject({ slots: [] }); // no table seats 7 any more
    expect(db().prepare("SELECT status FROM reservations").get()).toEqual({ status: "confirmed" });
  });
});

describe("booking integrity under the admin's changes", () => {
  it("one table, two guests for the same time: one booking and one 'taken', and a repeated submit returns the same row", async () => {
    const key = randomUUID();
    const first = book("2026-10-17", "20:00", 7, "9800000006", "hauz-khas", key);
    expect(first.status).toBe(201);
    expect(book("2026-10-17", "20:00", 7, "9800000006", "hauz-khas", key).status).toBe(200); // same key and body: the same booking
    expect(book("2026-10-17", "20:00", 7, "9800000007")).toMatchObject({ code: "SLOT_TAKEN" });
    expect(db().prepare("SELECT count(*) AS n FROM reservations").get()).toEqual({ n: 1 });
  });
});

describe("branches and restaurant details (D-25)", () => {
  const patch = (slug: string, body: object) => call(branchItemHandler(s.deps), "PATCH", `/api/admin/branches/${slug}`, body, { slug });

  it("lists branches with stored details and counts only", async () => {
    const r = (await call(branchesHandler(s.deps), "GET", "/api/admin/branches")).json;
    expect(r.restaurant.name).toBe("Neem & Ember");
    expect(r.branches.map((b: { slug: string; shortName: string; phoneLabel: string; counts: { tables: number; menuOnlyHere: number; faqs: number } }) => [b.slug, b.shortName, b.phoneLabel, b.counts.tables, b.counts.menuOnlyHere, b.counts.faqs])).toEqual([
      ["hauz-khas", "Hauz Khas", "+91 11 4155 0101", 6, 0, 3],
      ["gurugram", "Golf Course Road", "+91 124 455 0202", 6, 1, 4],
    ]);
    expect(r.menuEverywhere).toBe(47);
  });

  it("a rename reaches the branch fact and the branch FAQs' prefix, keyword index included", async () => {
    expect((await patch("hauz-khas", { name: "Neem & Ember, Hauz Khas Village" })).json).toMatchObject({ changed: true });
    expect(renderStaticFacts(loadFactSource(db()), NOW).find((f) => f.id === "branch:hauz-khas")?.text).toMatch(/^Neem & Ember, Hauz Khas Village\./);
    expect(renderKbFacts(loadFactSource(db())).find((f) => f.id === "faq:parking-hauz-khas")?.text).toMatch(/^\(Hauz Khas Village\) Q:/);
    expect(lexicalCurrent(db(), renderKbFacts(loadFactSource(db())))).toBe(true);
  });

  it("validates phone numbers and keeps one branch active; deactivating a branch with bookings needs confirmation", async () => {
    expect((await patch("hauz-khas", { phone: "12345" })).json.error.fields.phone).toMatch(/valid Indian phone/);
    expect((await patch("hauz-khas", { phone: "011 4155 0199" })).status).toBe(200);
    expect(db().prepare("SELECT phone FROM branches WHERE slug = 'hauz-khas'").get()).toEqual({ phone: "+911141550199" });
    const r = book("2026-10-17", "20:00", 2, "9800000008", "gurugram");
    if (!("reservation" in r)) throw new Error("booking failed");
    expect((await patch("gurugram", { isActive: false })).json.error).toMatchObject({ code: "CONFLICT", conflicts: [{ ref: r.reservation.ref }] });
    expect((await patch("gurugram", { isActive: false, confirm: true })).status).toBe(200);
    expect(slots("gurugram", "2026-10-18", 2)).toBeNull(); // branch inactive
    expect((await patch("hauz-khas", { isActive: false })).json.error.message).toMatch(/At least one branch must stay active/);
  });

  it("edits the restaurant-wide description the chatbot introduces itself with", async () => {
    const r = await call(restaurantHandler(s.deps), "PATCH", "/api/admin/restaurant", { about: "A two-branch modern Indian restaurant in Delhi NCR." });
    expect(r.json).toEqual({ changed: true, summary: "description" });
    expect(renderStaticFacts(loadFactSource(db()), NOW)[0].text).toContain("A two-branch modern Indian restaurant in Delhi NCR.");
    expect((await call(restaurantHandler(s.deps), "PATCH", "/api/admin/restaurant", { about: "short" })).status).toBe(400);
  });
});

describe("bookings list and details (D-25)", () => {
  const list = async (qs: string) => (await call(bookingsListHandler(s.deps), "GET", `/api/admin/reservations?${qs}`)).json;
  it("searches by name or reference across dates, filters by status, and never lists the full mobile, email or note", async () => {
    const a = book("2026-10-17", "20:00", 2, "9800000011");
    const b = book("2026-10-18", "13:00", 4, "9800000012", "gurugram");
    if (!("reservation" in a) || !("reservation" in b)) throw new Error("booking failed");
    expect((await list("q=guest 1")).items.map((i: { ref: string }) => i.ref)).toEqual([a.reservation.ref, b.reservation.ref]);
    expect((await list(`q=${b.reservation.ref.slice(3)}`)).items.map((i: { ref: string }) => i.ref)).toEqual([b.reservation.ref]);
    expect((await list(`q=${b.reservation.ref.toLowerCase()}`)).mode).toBe("search");
    expect((await list("q=%25")).items).toEqual([]); // "%" is a character, not a wildcard
    await call(bookingItemHandlers(s.deps).PATCH, "PATCH", `/api/admin/reservations/${a.reservation.ref}`, { status: "cancelled" }, { ref: a.reservation.ref });
    expect((await list("q=guest&status=cancelled")).items.map((i: { ref: string }) => i.ref)).toEqual([a.reservation.ref]);
    const day = await list("date=2026-10-17&status=confirmed");
    expect(day).toMatchObject({ mode: "day", items: [], totals: { confirmed: 0, covers: 0, cancelled: 1 } });
    const body = JSON.stringify(await list("q=guest"));
    expect(body).not.toContain("9800000011");
    expect(body).not.toContain("window seat");
    expect(body).not.toContain("@example.com");
  });

  it("shows the full details on request, and cancelling twice reports the second as no change", async () => {
    const a = book("2026-10-17", "20:00", 2, "9800000013");
    if (!("reservation" in a)) throw new Error("booking failed");
    const d = (await call(bookingItemHandlers(s.deps).GET, "GET", `/api/admin/reservations/${a.reservation.ref}`, undefined, { ref: a.reservation.ref })).json;
    expect(d).toMatchObject({ phoneLabel: "+91 98000 00013", email: "g13@example.com", note: "window seat", table: "T1", source: "Chatbot", endLabel: "9:30 PM", sittingMinutes: 90 });
    const cancel = () => call(bookingItemHandlers(s.deps).PATCH, "PATCH", `/api/admin/reservations/${a.reservation.ref}`, { status: "cancelled" }, { ref: a.reservation.ref });
    expect((await cancel()).json.changed).toBe(true);
    expect((await cancel()).json.changed).toBe(false);
    expect(db().prepare("SELECT area, action, summary FROM admin_changes").all()).toEqual([{ area: "bookings", action: "cancelled", summary: `Cancelled booking ${a.reservation.ref}` }]);
    expect(() => applySeed(db(), SEED, { now: NOW })).not.toThrow(); // a cancellation isn't a data edit a reseed would overwrite
    expect((await call(bookingItemHandlers(s.deps).GET, "GET", "/api/admin/reservations/NE-00000000", undefined, { ref: "NE-00000000" })).status).toBe(404);
  });

  it("the overview reports today's real numbers and raises no warnings on healthy data", async () => {
    book("2026-10-16", "20:00", 3, "9800000014");
    const o = (await call(overviewHandler(s.deps), "GET", "/api/admin/overview")).json;
    expect(o.bookings.today).toMatchObject({ confirmed: 1, covers: 3, cancelled: 0 });
    expect(o.bookings.next).toMatchObject([{ timeLabel: "8:00 PM", partySize: 3, branch: "Hauz Khas" }]);
    expect(o.menu).toMatchObject({ listed: 48, available: 47, unavailable: 1, removed: 0 });
    expect(o.knowledge).toMatchObject({ documents: 0, mode: "hybrid" });
    expect(o.warnings).toEqual([]);
  });
});
