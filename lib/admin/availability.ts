import { z } from "zod";
import { RULES } from "@/lib/config";
import type { DB } from "@/lib/db/client";
import { closeTime, exceptionProblems, hhmm, overlaps } from "@/lib/db/seed-schema";
import { gridStarts, validateQuery, type StartStatus } from "@/lib/booking/availability";
import { findConflicts, newConflicts, type SeedConflict } from "@/lib/booking/conflicts";
import { windowsFor, type Service } from "@/lib/booking/hours";
import { loadAvailabilityData } from "@/lib/booking/load";
import { branchShortName } from "@/lib/kb/facts";
import { addLocalDays, dayLabelLong, daysBetween, instantAtMinutes, isLocalDate, localDateOf, localTimeOf, minutesOf, timeLabel, timeLabelOf, todayLocal, weekdayOf, type LocalDate } from "@/lib/time/tz";
import { AdminError, adminWrite, fieldError, line, notFound, oneLine, parse } from "@/lib/admin/common";

// Availability management (D-25). It edits the same rows the availability engine reads (service_hours,
// hours_exceptions, dining_tables, and the new slot_blocks), and every view is computed by the engine itself
// (gridStarts, validateQuery), so what staff see is what the chatbot and /api/availability offer.
// Capacity is table by table (each table seats min–max guests; a booking holds one table for its sitting). Sitting
// time, slot interval, lead time, booking window and online party size are fixed in code (lib/config.ts RULES).
// A change that would leave confirmed future bookings outside the hours or without a fitting table is refused until
// staff confirm it; bookings are never moved or cancelled by these edits.

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SHORTEST_SITTING = Math.min(RULES.sittingMinutes(1), RULES.sittingMinutes(RULES.onlinePartyMax));

type BranchRow = { id: number; slug: string; name: string; timezone: string; is_active: number };
function branchOf(db: DB, slug: string): BranchRow {
  const b = db.prepare("SELECT id, slug, name, timezone, is_active FROM branches WHERE slug = ?").get(slug) as BranchRow | undefined;
  if (!b) throw notFound("Branch");
  return b;
}

export const RULES_VIEW = {
  slotMinutes: RULES.slotMinutes,
  sittingSmall: RULES.sittingMinutes(1),
  sittingLarge: RULES.sittingMinutes(RULES.onlinePartyMax),
  largePartyFrom: 5,
  leadMinutes: RULES.leadMinutes,
  horizonDays: RULES.horizonDays,
  partyMin: RULES.onlinePartyMin,
  partyMax: RULES.onlinePartyMax,
  timezone: RULES.timezone,
};

export type ConflictView = { ref: string; branch: string; dateLabel: string; timeLabel: string; reason: string };
const REASON: Record<SeedConflict["reason"], string> = { outside_hours: "would be outside the opening hours", table_inactive: "is on a table or branch that would be inactive", table_size: "would no longer fit its table" };
function describeConflicts(db: DB, cs: SeedConflict[]): ConflictView[] {
  const zones = new Map((db.prepare("SELECT slug, timezone FROM branches").all() as { slug: string; timezone: string }[]).map((b) => [b.slug, b.timezone]));
  return cs.map((c) => {
    const zone = zones.get(c.branch) ?? RULES.timezone;
    return { ref: c.ref, branch: c.branch, dateLabel: dayLabelLong(localDateOf(c.startsAt, zone), zone), timeLabel: timeLabel(c.startsAt, zone), reason: REASON[c.reason] };
  });
}

/**
 * Run a change, then refuse it (rolling back) if it creates booking conflicts that staff haven't confirmed. Returns the
 * conflicts staff accepted, so the UI can list the bookings to follow up.
 */
function guarded<T>(db: DB, now: number, confirm: boolean | undefined, change: () => T): { result: T; accepted: ConflictView[] } {
  const before = findConflicts(db, now);
  const result = change();
  const added = newConflicts(before, findConflicts(db, now));
  if (added.length && !confirm)
    throw new AdminError(409, "CONFLICT", `${added.length} confirmed ${added.length === 1 ? "booking" : "bookings"} would no longer fit. Nothing was saved. Confirm to save anyway (the bookings stay booked; contact the guests).`, { conflicts: describeConflicts(db, added) });
  return { result, accepted: describeConflicts(db, added) };
}

// ---------- day view ----------

export type DayView = {
  branch: { slug: string; name: string; shortName: string; isActive: boolean; timezone: string };
  date: LocalDate;
  dateLabel: string;
  today: LocalDate;
  partySize: number;
  /** Whether guests can book this date at all, and why not. */
  bookable: { ok: boolean; reason: string | null };
  hours: { source: "weekly" | "special"; windows: { service: Service; opens: string; closes: string; label: string }[]; note: string | null };
  starts: { time: string; label: string; service: Service; status: StartStatus; freeTables: number; fittingTables: number; startingHere: number; blockReason: string | null }[];
  tables: { id: number; label: string; minSeats: number; maxSeats: number; isActive: boolean; bookings: { ref: string; guestName: string; partySize: number; startsAt: number; endsAt: number; startLabel: string; endLabel: string }[] }[];
  summary: { bookings: number; covers: number; open: number; blocked: number; full: number };
  rules: typeof RULES_VIEW;
};

const BOOKABLE_REASON: Record<string, string> = {
  past_date: "This date is in the past.",
  past_horizon: `Guests can book up to ${RULES.horizonDays} days ahead, so this date isn't open to bookings yet.`,
  branch_inactive: "This branch is inactive, so guests can't book it.",
  party_too_large: `Online bookings are for 1 to ${RULES.onlinePartyMax} guests.`,
  party_size: `Online bookings are for 1 to ${RULES.onlinePartyMax} guests.`,
};

export function dayView(db: DB, now: number, slug: string, date: string, partySize: number): DayView {
  const b = branchOf(db, slug);
  if (!isLocalDate(date)) throw fieldError("date", "Use a date like 2026-10-24");
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) throw fieldError("party", "Party size is 1 to 20");
  const bundle = loadAvailabilityData(db, [date]);
  const branch = bundle.branches.find((x) => x.id === b.id)!;
  const weekly = bundle.weekly.get(b.id) ?? [];
  const exceptions = (bundle.exceptions.get(b.id) ?? []).filter((e) => e.date === date);
  const windows = windowsFor(date, weekdayOf(date, b.timezone), weekly, exceptions);
  const grid = gridStarts(bundle, branch, date, Math.min(partySize, RULES.onlinePartyMax), now);
  const q = validateQuery(bundle, { branch: slug, date, partySize }, now);
  // A day of margin each side (sittings that cross midnight), then filtered to bookings starting on the local date.
  const dayStart = instantAtMinutes(addLocalDays(date, -1, b.timezone), 0, b.timezone);
  const rows = db
    .prepare(
      `SELECT r.ref, r.guest_name, r.party_size, r.starts_at, r.ends_at, r.table_id FROM reservations r
       WHERE r.branch_id = ? AND r.status = 'confirmed' AND r.ends_at > ? AND r.starts_at < ? ORDER BY r.starts_at`,
    )
    .all(b.id, dayStart, instantAtMinutes(addLocalDays(date, 2, b.timezone), 0, b.timezone)) as { ref: string; guest_name: string; party_size: number; starts_at: number; ends_at: number; table_id: number }[];
  const onDate = rows.filter((r) => localDateOf(r.starts_at, b.timezone) === date);
  const blockRows = db.prepare("SELECT time, reason FROM slot_blocks WHERE branch_id = ? AND date = ?").all(b.id, date) as { time: string; reason: string | null }[];
  const blockReason = new Map(blockRows.map((x) => [x.time, x.reason]));
  const tables = (db.prepare("SELECT id, label, min_seats, max_seats, is_active FROM dining_tables WHERE branch_id = ? ORDER BY length(label), label").all(b.id) as { id: number; label: string; min_seats: number; max_seats: number; is_active: number }[]).map((t) => ({
    id: t.id,
    label: t.label,
    minSeats: t.min_seats,
    maxSeats: t.max_seats,
    isActive: t.is_active === 1,
    bookings: onDate.filter((r) => r.table_id === t.id).map((r) => ({ ref: r.ref, guestName: r.guest_name, partySize: r.party_size, startsAt: r.starts_at, endsAt: r.ends_at, startLabel: timeLabel(r.starts_at, b.timezone), endLabel: timeLabel(r.ends_at, b.timezone) })),
  }));
  const starts = grid.starts.map((s) => ({
    time: s.time,
    label: timeLabel(s.startsAt, b.timezone),
    service: s.service,
    status: s.status,
    freeTables: s.freeTables,
    fittingTables: s.fittingTables,
    startingHere: onDate.filter((r) => r.starts_at === s.startsAt).length,
    blockReason: blockReason.get(s.time) ?? null,
  }));
  return {
    branch: { slug: b.slug, name: b.name, shortName: branchShortName(b.name), isActive: b.is_active === 1, timezone: b.timezone },
    date,
    dateLabel: dayLabelLong(date, b.timezone),
    today: todayLocal(now, b.timezone),
    partySize,
    bookable: q.ok ? { ok: true, reason: partySize > RULES.onlinePartyMax ? BOOKABLE_REASON.party_too_large : null } : { ok: false, reason: BOOKABLE_REASON[q.error] ?? "Guests can't book this date." },
    hours: {
      source: exceptions.length ? "special" : "weekly",
      windows: windows.map((w) => {
        const opens = `${String(Math.floor(w.opensMin / 60)).padStart(2, "0")}:${String(w.opensMin % 60).padStart(2, "0")}`;
        const closes = w.closesMin === 1440 ? "24:00" : `${String(Math.floor(w.closesMin / 60)).padStart(2, "0")}:${String(w.closesMin % 60).padStart(2, "0")}`;
        return { service: w.service, opens, closes, label: `${timeLabelOf(opens)} to ${timeLabelOf(closes)}` };
      }),
      note: [...new Set(exceptions.map((e) => e.note).filter(Boolean))].join("; ") || null,
    },
    starts,
    tables,
    summary: { bookings: onDate.length, covers: onDate.reduce((n, r) => n + r.party_size, 0), open: starts.filter((s) => s.status === "open").length, blocked: blockRows.length, full: starts.filter((s) => s.status === "full").length },
    rules: RULES_VIEW,
  };
}

// ---------- weekly hours ----------

const SITTING_TEXT = `${Math.floor(SHORTEST_SITTING / 60)} h${SHORTEST_SITTING % 60 ? ` ${SHORTEST_SITTING % 60} min` : ""}`;
const Window = z
  .strictObject({ opens: hhmm, closes: closeTime })
  .refine((w) => minutesOf(w.closes) > minutesOf(w.opens), "Closing time must be after opening time")
  .refine((w) => minutesOf(w.closes) - minutesOf(w.opens) >= SHORTEST_SITTING, `A service needs at least ${SITTING_TEXT} so a table can be booked`);
type Win = z.infer<typeof Window>;

export type WeeklyDay = { weekday: number; label: string; lunch: Win | null; dinner: Win | null };

export function weeklyHours(db: DB, slug: string): WeeklyDay[] {
  const b = branchOf(db, slug);
  const rows = db.prepare("SELECT weekday, service, opens, closes FROM service_hours WHERE branch_id = ?").all(b.id) as { weekday: number; service: Service; opens: string; closes: string }[];
  return WEEK_ORDER.map((wd) => {
    const of = (s: Service) => {
      const r = rows.find((x) => x.weekday === wd && x.service === s);
      return r ? { opens: r.opens, closes: r.closes } : null;
    };
    return { weekday: wd, label: DAY_NAMES[wd], lunch: of("lunch"), dinner: of("dinner") };
  });
}

export const WeeklySchema = z.strictObject({
  days: z
    .array(z.strictObject({ weekday: z.number().int().min(0).max(6), lunch: Window.nullable(), dinner: Window.nullable() }))
    .length(7, "Give all seven days")
    .refine((d) => new Set(d.map((x) => x.weekday)).size === 7, "Each weekday once"),
  confirm: z.boolean().optional(),
});

export function setWeeklyHours(db: DB, now: number, slug: string, raw: unknown): { accepted: ConflictView[]; summary: string } {
  const input = parse(WeeklySchema, raw);
  for (const d of input.days) if (d.lunch && d.dinner && overlaps([d.lunch, d.dinner])) throw fieldError("days", `Lunch and dinner overlap on ${DAY_NAMES[d.weekday]}`);
  const b = branchOf(db, slug);
  return adminWrite(db, now, { reindex: false }, () => {
    const before = weeklyHours(db, slug);
    const { accepted } = guarded(db, now, input.confirm, () => {
      db.prepare("DELETE FROM service_hours WHERE branch_id = ?").run(b.id);
      const ins = db.prepare("INSERT INTO service_hours (branch_id, weekday, service, opens, closes) VALUES (?, ?, ?, ?, ?)");
      for (const d of input.days) for (const s of ["lunch", "dinner"] as const) if (d[s]) ins.run(b.id, d.weekday, s, d[s]!.opens, d[s]!.closes);
    });
    const after = weeklyHours(db, slug);
    const fmt = (w: Win | null) => (w ? `${w.opens}–${w.closes}` : "closed");
    const changed = after.filter((d, i) => JSON.stringify(d) !== JSON.stringify(before[i])).map((d) => `${d.label.slice(0, 3)} lunch ${fmt(d.lunch)}, dinner ${fmt(d.dinner)}`);
    const summary = changed.length ? changed.join("; ") : "no change";
    return { result: { accepted, summary }, change: changed.length ? { area: "hours", action: "weekly hours", target: slug, summary: `${branchShortName(b.name)}: ${summary}` } : null };
  });
}

// ---------- special dates (exceptions) ----------

export type SpecialDate = { date: LocalDate; label: string; closedAllDay: boolean; lunch: Win | null; dinner: Win | null; note: string | null; inBookingWindow: boolean };

export function specialDates(db: DB, now: number, slug: string): SpecialDate[] {
  const b = branchOf(db, slug);
  const today = todayLocal(now, b.timezone);
  const rows = db.prepare("SELECT date, service, is_closed, opens, closes, note FROM hours_exceptions WHERE branch_id = ? AND date >= ? ORDER BY date").all(b.id, today) as { date: string; service: Service | null; is_closed: number; opens: string | null; closes: string | null; note: string | null }[];
  const dates = [...new Set(rows.map((r) => r.date))];
  return dates.map((date) => {
    const rs = rows.filter((r) => r.date === date);
    const win = (s: Service) => {
      const r = rs.find((x) => x.service === s);
      return r && !r.is_closed && r.opens && r.closes ? { opens: r.opens, closes: r.closes } : null;
    };
    return { date, label: dayLabelLong(date, b.timezone), closedAllDay: rs.some((r) => r.service === null), lunch: win("lunch"), dinner: win("dinner"), note: [...new Set(rs.map((r) => r.note).filter(Boolean))].join("; ") || null, inBookingWindow: daysBetween(today, date) <= RULES.horizonDays };
  });
}

export const SpecialSchema = z.strictObject({
  closedAllDay: z.boolean(),
  lunch: Window.nullable(),
  dinner: Window.nullable(),
  note: z.string().max(200).nullable().transform((s) => (s ? oneLine(s) || null : null)).pipe(z.string().max(120, "Notes can be up to 120 characters").nullable()),
  confirm: z.boolean().optional(),
});

function checkFutureDate(now: number, zone: string, date: string) {
  if (!isLocalDate(date)) throw fieldError("date", "Use a date like 2026-10-24");
  const offset = daysBetween(todayLocal(now, zone), date);
  if (offset < 0) throw fieldError("date", "That date is in the past");
  if (offset > 366) throw fieldError("date", "Choose a date within the next year");
}

export function setSpecialDate(db: DB, now: number, slug: string, date: string, raw: unknown): { accepted: ConflictView[] } {
  const input = parse(SpecialSchema, raw);
  const b = branchOf(db, slug);
  checkFutureDate(now, b.timezone, date);
  if (!input.closedAllDay && input.lunch && input.dinner && overlaps([input.lunch, input.dinner])) throw fieldError("dinner", "Lunch and dinner overlap");
  // D-08: a whole-day row is only a closure; otherwise both services are listed (open or closed), so neither is closed
  // by omission. Both closed is stored as a whole-day closure.
  const whole = input.closedAllDay || (!input.lunch && !input.dinner);
  const rows = whole
    ? [{ service: null, isClosed: true, opens: null, closes: null }]
    : (["lunch", "dinner"] as const).map((s) => ({ service: s, isClosed: !input[s], opens: input[s]?.opens ?? null, closes: input[s]?.closes ?? null }));
  const problems = exceptionProblems(rows.map((r) => ({ ...r, key: date })));
  if (problems.length) throw new AdminError(400, "VALIDATION", problems.join("; "));
  return adminWrite(db, now, { reindex: false }, () => {
    const { accepted } = guarded(db, now, input.confirm, () => {
      db.prepare("DELETE FROM hours_exceptions WHERE branch_id = ? AND date = ?").run(b.id, date);
      const ins = db.prepare("INSERT INTO hours_exceptions (branch_id, date, service, is_closed, opens, closes, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const r of rows) ins.run(b.id, date, r.service, r.isClosed ? 1 : 0, r.opens, r.closes, input.note);
    });
    const desc = whole ? "closed all day" : rows.map((r) => `${r.service} ${r.isClosed ? "closed" : `${r.opens}–${r.closes}`}`).join(", ");
    return { result: { accepted }, change: { area: "exceptions", action: "special date", target: `${slug}/${date}`, summary: `${branchShortName(b.name)} on ${date}: ${desc}${input.note ? ` (${input.note})` : ""}` } };
  });
}

export function deleteSpecialDate(db: DB, now: number, slug: string, date: string, confirm: boolean | undefined): { accepted: ConflictView[] } {
  const b = branchOf(db, slug);
  if (!isLocalDate(date)) throw fieldError("date", "Use a date like 2026-10-24");
  return adminWrite(db, now, { reindex: false }, () => {
    if (!db.prepare("SELECT 1 FROM hours_exceptions WHERE branch_id = ? AND date = ?").get(b.id, date)) throw notFound("Special date");
    const { accepted } = guarded(db, now, confirm, () => db.prepare("DELETE FROM hours_exceptions WHERE branch_id = ? AND date = ?").run(b.id, date));
    return { result: { accepted }, change: { area: "exceptions", action: "removed special date", target: `${slug}/${date}`, summary: `${branchShortName(b.name)} on ${date}: back to the weekly hours` } };
  });
}

// ---------- slot blocks ----------

export const BlockSchema = z.strictObject({
  times: z.array(hhmm).min(1, "Choose at least one time").max(48),
  reason: z.string().max(200).nullable().optional().transform((s) => (s ? oneLine(s) || null : null)).pipe(z.string().max(120, "Reasons can be up to 120 characters").nullable()),
});

/** Block start times on a date (idempotent: an already blocked time is left as it is). */
export function blockSlots(db: DB, now: number, slug: string, date: string, raw: unknown): { added: string[]; already: string[]; bookingsAtTimes: number } {
  const input = parse(BlockSchema, raw);
  const b = branchOf(db, slug);
  checkFutureDate(now, b.timezone, date);
  return adminWrite(db, now, { reindex: false }, () => {
    const bundle = loadAvailabilityData(db, [date]);
    const windows = windowsFor(date, weekdayOf(date, b.timezone), bundle.weekly.get(b.id) ?? [], bundle.exceptions.get(b.id) ?? []);
    for (const t of input.times) {
      const m = minutesOf(t);
      if (!windows.some((w) => m >= w.opensMin && m < w.closesMin && (m - w.opensMin) % RULES.slotMinutes === 0)) throw fieldError("times", `${timeLabelOf(t)} isn't a booking time on ${date}`);
    }
    const ins = db.prepare("INSERT OR IGNORE INTO slot_blocks (branch_id, date, time, reason, created_at) VALUES (?, ?, ?, ?, ?)");
    const added: string[] = [];
    const already: string[] = [];
    for (const t of [...new Set(input.times)]) (ins.run(b.id, date, t, input.reason, now).changes ? added : already).push(t);
    const bookingsAtTimes = (db.prepare("SELECT starts_at FROM reservations WHERE branch_id = ? AND status = 'confirmed'").all(b.id) as { starts_at: number }[]).filter((r) => localDateOf(r.starts_at, b.timezone) === date && input.times.includes(localTimeOf(r.starts_at, b.timezone))).length;
    return {
      result: { added, already, bookingsAtTimes },
      change: added.length ? { area: "blocks", action: "blocked", target: `${slug}/${date}`, summary: `${branchShortName(b.name)} on ${date}: blocked ${added.map(timeLabelOf).join(", ")}${input.reason ? ` (${input.reason})` : ""}` } : null,
    };
  });
}

export function unblockSlots(db: DB, now: number, slug: string, date: string, raw: unknown): { removed: string[] } {
  const input = parse(BlockSchema.pick({ times: true }), raw);
  const b = branchOf(db, slug);
  if (!isLocalDate(date)) throw fieldError("date", "Use a date like 2026-10-24");
  return adminWrite(db, now, { reindex: false }, () => {
    const del = db.prepare("DELETE FROM slot_blocks WHERE branch_id = ? AND date = ? AND time = ?");
    const removed = [...new Set(input.times)].filter((t) => del.run(b.id, date, t).changes > 0);
    return { result: { removed }, change: removed.length ? { area: "blocks", action: "reopened", target: `${slug}/${date}`, summary: `${branchShortName(b.name)} on ${date}: reopened ${removed.map(timeLabelOf).join(", ")}` } : null };
  });
}

/** Upcoming blocks for a branch (today on). */
export function upcomingBlocks(db: DB, now: number, slug: string): { date: string; dateLabel: string; time: string; label: string; reason: string | null }[] {
  const b = branchOf(db, slug);
  return (db.prepare("SELECT date, time, reason FROM slot_blocks WHERE branch_id = ? AND date >= ? ORDER BY date, time").all(b.id, todayLocal(now, b.timezone)) as { date: string; time: string; reason: string | null }[]).map((r) => ({
    ...r,
    dateLabel: dayLabelLong(r.date, b.timezone),
    label: timeLabelOf(r.time),
  }));
}

// ---------- tables (capacity) ----------

export type TableView = { id: number; label: string; minSeats: number; maxSeats: number; isActive: boolean; upcomingBookings: number };

export function listTables(db: DB, now: number, slug: string): TableView[] {
  const b = branchOf(db, slug);
  return (
    db
      .prepare(
        `SELECT t.id, t.label, t.min_seats, t.max_seats, t.is_active,
           (SELECT count(*) FROM reservations r WHERE r.table_id = t.id AND r.status = 'confirmed' AND r.ends_at > ?) AS upcoming
         FROM dining_tables t WHERE t.branch_id = ? ORDER BY length(t.label), t.label`,
      )
      .all(now, b.id) as { id: number; label: string; min_seats: number; max_seats: number; is_active: number; upcoming: number }[]
  ).map((t) => ({ id: t.id, label: t.label, minSeats: t.min_seats, maxSeats: t.max_seats, isActive: t.is_active === 1, upcomingBookings: t.upcoming }));
}

const Seats = z.number({ error: "Enter a number of seats" }).int("Use whole seats").min(1, "At least 1 seat").max(20, "At most 20 seats");
export const TableCreateSchema = z
  .strictObject({ label: line("a table label", 1, 12).pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, "Use letters, numbers, spaces or dashes")), minSeats: Seats, maxSeats: Seats })
  .refine((t) => t.maxSeats >= t.minSeats, { message: "Most guests must be at least the fewest guests", path: ["maxSeats"] });
export const TablePatchSchema = z.strictObject({ minSeats: Seats.optional(), maxSeats: Seats.optional(), isActive: z.boolean().optional(), confirm: z.boolean().optional() });

export function addTable(db: DB, now: number, slug: string, raw: unknown): TableView {
  const input = parse(TableCreateSchema, raw);
  const b = branchOf(db, slug);
  return adminWrite(db, now, { reindex: false }, () => {
    if (db.prepare("SELECT 1 FROM dining_tables WHERE branch_id = ? AND lower(label) = lower(?)").get(b.id, input.label)) throw new AdminError(409, "CONFLICT", `${branchShortName(b.name)} already has a table ${input.label}.`);
    db.prepare("INSERT INTO dining_tables (branch_id, label, min_seats, max_seats, is_active) VALUES (?, ?, ?, ?, 1)").run(b.id, input.label, input.minSeats, input.maxSeats);
    const t = listTables(db, now, slug).find((x) => x.label === input.label)!;
    return { result: t, change: { area: "tables", action: "added", target: `${slug}/${input.label}`, summary: `${branchShortName(b.name)}: added table ${input.label} for ${input.minSeats}–${input.maxSeats} guests` } };
  });
}

export function updateTable(db: DB, now: number, slug: string, id: number, raw: unknown): { table: TableView; accepted: ConflictView[] } {
  const input = parse(TablePatchSchema, raw);
  const b = branchOf(db, slug);
  return adminWrite(db, now, { reindex: false }, () => {
    const t = db.prepare("SELECT id, label, min_seats, max_seats, is_active FROM dining_tables WHERE id = ? AND branch_id = ?").get(id, b.id) as { id: number; label: string; min_seats: number; max_seats: number; is_active: number } | undefined;
    if (!t) throw notFound("Table");
    const min = input.minSeats ?? t.min_seats;
    const max = input.maxSeats ?? t.max_seats;
    if (max < min) throw fieldError("maxSeats", "Most guests must be at least the fewest guests");
    const active = input.isActive ?? t.is_active === 1;
    const { accepted } = guarded(db, now, input.confirm, () => db.prepare("UPDATE dining_tables SET min_seats = ?, max_seats = ?, is_active = ? WHERE id = ?").run(min, max, active ? 1 : 0, id));
    const parts = [min !== t.min_seats || max !== t.max_seats ? `seats ${t.min_seats}–${t.max_seats} → ${min}–${max}` : null, active !== (t.is_active === 1) ? (active ? "activated" : "deactivated") : null].filter(Boolean);
    return {
      result: { table: listTables(db, now, slug).find((x) => x.id === id)!, accepted },
      change: parts.length ? { area: "tables", action: "edited", target: `${slug}/${t.label}`, summary: `${branchShortName(b.name)} table ${t.label}: ${parts.join("; ")}` } : null,
    };
  });
}
