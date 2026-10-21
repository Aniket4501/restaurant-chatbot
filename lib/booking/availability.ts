import { RULES } from "@/lib/config";
import { windowsFor, type HoursException, type Service, type WeeklyHours } from "@/lib/booking/hours";
import { addLocalDays, daysBetween, instantAtMinutes, isLocalDate, localDateOf as localDateOfInstant, localTimeOf as localTimeOfInstant, minutesOf, timeLabel, timeOfMinutes, todayLocal, weekdayOf, type LocalDate } from "@/lib/time/tz";

// Availability engine (MASTER_PROMPT §5.5). Pure: everything it needs is in the bundle, and `now` is a
// parameter. The booking service re-validates with the same functions inside its transaction.

export type BranchRow = { id: number; slug: string; name: string; timezone: string; isActive: boolean };
export type TableRow = { id: number; branchId: number; label: string; minSeats: number; maxSeats: number; isActive: boolean };
export type BookingInterval = { tableId: number; startsAt: number; endsAt: number };
export type AvailabilityBundle = {
  branches: BranchRow[];
  weekly: Map<number, WeeklyHours[]>;
  exceptions: Map<number, HoursException[]>;
  tables: TableRow[];
  /** Confirmed bookings only. */
  bookings: BookingInterval[];
  /** Start times staff have blocked (D-25), per branch id, as "YYYY-MM-DD|HH:MM" in the branch zone. Absent: none. */
  blocks?: Map<number, Set<string>>;
};

export type AvailabilityQuery = { branch: string; date: LocalDate; partySize: number; time?: string | null; window?: Service | null };
export type Slot = { branch: string; date: LocalDate; time: string; startsAt: number; endsAt: number; service: Service; label: string };
export type AvailabilityError = "unknown_branch" | "branch_inactive" | "party_size" | "party_too_large" | "invalid_date" | "past_date" | "past_horizon";
export type AvailabilityResult =
  | {
      ok: true;
      branch: string;
      date: LocalDate;
      partySize: number;
      sittingMinutes: number;
      slots: Slot[];
      /** false when a window was requested but had no open start, so slots come from the rest of the day (BR-08). */
      matchedWindow: boolean;
      alternatives: Slot[];
      reason: null | "closed" | "no_more_today" | "fully_booked";
    }
  | { ok: false; error: AvailabilityError };

const MAX_SLOTS = 6;
const PER_SERVICE = 3;
const ALT_PER_GROUP = 3;
const ALT_DAYS = 2;

/** Why a grid start can or can't be booked right now (D-25 admin view; openStarts keeps the "open" ones). */
export type StartStatus = "open" | "lead_time" | "blocked" | "full";
export type GridStart = {
  time: string;
  minute: number;
  startsAt: number;
  endsAt: number;
  service: Service;
  status: StartStatus;
  /** Active tables that seat the party, and how many of them are free for the whole sitting. */
  fittingTables: number;
  freeTables: number;
};

/** A start staff have blocked (D-25). */
export function isBlocked(bundle: AvailabilityBundle, branchId: number, date: LocalDate, time: string): boolean {
  return bundle.blocks?.get(branchId)?.has(`${date}|${time}`) ?? false;
}

/**
 * §5.5 steps 2–5 for one branch and date: every grid start of the day's service windows with its status. Lead time
 * comes first, then a staff block, then table fit, so a fully blocked evening reads as fully booked to guests, not closed.
 */
export function gridStarts(bundle: AvailabilityBundle, branch: BranchRow, date: LocalDate, partySize: number, now: number): { starts: GridStart[]; hadWindows: boolean } {
  const sitting = RULES.sittingMinutes(partySize);
  const windows = windowsFor(date, weekdayOf(date, branch.timezone), bundle.weekly.get(branch.id) ?? [], bundle.exceptions.get(branch.id) ?? []);
  const earliest = now + RULES.leadMinutes * 60_000;
  const fitting = bundle.tables.filter((t) => t.branchId === branch.id && t.isActive && t.minSeats <= partySize && partySize <= t.maxSeats);
  const starts: GridStart[] = [];
  const seen = new Set<number>();
  for (const w of windows) {
    for (let m = w.opensMin; m + sitting <= w.closesMin; m += RULES.slotMinutes) {
      const startsAt = instantAtMinutes(date, m, branch.timezone);
      if (seen.has(startsAt)) continue; // overlapping windows offer each start once (review AV-1)
      seen.add(startsAt);
      const endsAt = startsAt + sitting * 60_000;
      const time = timeOfMinutes(m);
      const freeTables = fitting.filter((t) => isFree(bundle.bookings, t.id, startsAt, endsAt)).length;
      const status: StartStatus = startsAt < earliest ? "lead_time" : isBlocked(bundle, branch.id, date, time) ? "blocked" : freeTables > 0 ? "open" : "full";
      starts.push({ time, minute: m, startsAt, endsAt, service: w.service, status, fittingTables: fitting.length, freeTables });
    }
  }
  return { starts, hadWindows: windows.length > 0 };
}

/** §5.5 steps 1–5 for one branch and date: every grid start that is open right now. */
export function openStarts(bundle: AvailabilityBundle, branch: BranchRow, date: LocalDate, partySize: number, now: number): { open: Slot[]; hadWindows: boolean; hadCandidates: boolean } {
  const { starts, hadWindows } = gridStarts(bundle, branch, date, partySize, now);
  const open = starts
    .filter((s) => s.status === "open")
    .map((s) => ({ branch: branch.slug, date, time: s.time, startsAt: s.startsAt, endsAt: s.endsAt, service: s.service, label: timeLabel(s.startsAt, branch.timezone) }));
  // Step 4 removes starts within the lead time; anything after it (blocked or full) still counts as a candidate.
  return { open, hadWindows, hadCandidates: starts.some((s) => s.status !== "lead_time") };
}

function isFree(bookings: BookingInterval[], tableId: number, start: number, end: number): boolean {
  return !bookings.some((b) => b.tableId === tableId && b.startsAt < end && start < b.endsAt);
}

/** BR-10: the smallest free active table that fits (fewest max seats, then fewest min seats, then label). */
export function pickTable(bundle: AvailabilityBundle, branchId: number, partySize: number, startsAt: number, endsAt: number): TableRow | null {
  return (
    bundle.tables
      .filter((t) => t.branchId === branchId && t.isActive && t.minSeats <= partySize && partySize <= t.maxSeats && isFree(bundle.bookings, t.id, startsAt, endsAt))
      .sort((a, b) => a.maxSeats - b.maxSeats || a.minSeats - b.minSeats || a.label.localeCompare(b.label, "en", { numeric: true }))[0] ?? null
  );
}

/** Step 1: query validation shared with the booking service's re-validation. */
export function validateQuery(bundle: AvailabilityBundle, q: Pick<AvailabilityQuery, "branch" | "date" | "partySize">, now: number): { ok: true; branch: BranchRow } | { ok: false; error: AvailabilityError } {
  const branch = bundle.branches.find((b) => b.slug === q.branch);
  if (!branch) return { ok: false, error: "unknown_branch" };
  if (!branch.isActive) return { ok: false, error: "branch_inactive" };
  if (!Number.isInteger(q.partySize) || q.partySize < RULES.onlinePartyMin) return { ok: false, error: "party_size" };
  if (q.partySize > RULES.onlinePartyMax) return { ok: false, error: "party_too_large" };
  if (!isLocalDate(q.date)) return { ok: false, error: "invalid_date" };
  const offset = daysBetween(todayLocal(now, branch.timezone), q.date);
  if (offset < 0) return { ok: false, error: "past_date" };
  if (offset > RULES.horizonDays) return { ok: false, error: "past_horizon" };
  return { ok: true, branch };
}

const byNearness = (target: number) => (a: Slot, b: Slot) => Math.abs(a.startsAt - target) - Math.abs(b.startsAt - target) || a.startsAt - b.startsAt;
const chronological = (a: Slot, b: Slot) => a.startsAt - b.startsAt;

export function getAvailability(q: AvailabilityQuery, bundle: AvailabilityBundle, now: number): AvailabilityResult {
  const v = validateQuery(bundle, q, now);
  if (!v.ok) return v;
  const branch = v.branch;
  const { open, hadWindows, hadCandidates } = openStarts(bundle, branch, q.date, q.partySize, now);
  const preferred = q.time ? instantAtMinutes(q.date, minutesOf(q.time), branch.timezone) : null;

  // Step 6: rank. A time or a window only ranks results (BR-08).
  let slots: Slot[];
  let matchedWindow = true;
  if (preferred !== null) {
    slots = [...open].sort(byNearness(preferred)).slice(0, MAX_SLOTS).sort(chronological);
  } else if (q.window) {
    const inWindow = open.filter((s) => s.service === q.window);
    matchedWindow = inWindow.length > 0;
    slots = (matchedWindow ? inWindow : open).slice(0, MAX_SLOTS);
  } else {
    slots = (["lunch", "dinner"] as const).flatMap((svc) => open.filter((s) => s.service === svc).slice(0, PER_SERVICE));
  }

  // Step 7: reason when nothing is open.
  const reason = open.length ? null : !hadWindows ? "closed" : !hadCandidates ? "no_more_today" : "fully_booked";

  // Step 8: alternatives when the preferred time (or window) isn't open, or nothing is open.
  const preferredOpen = preferred === null || open.some((s) => s.startsAt === preferred);
  const needAlternatives = !open.length || !preferredOpen || !matchedWindow;
  const alternatives = needAlternatives ? findAlternatives(bundle, branch, q, now) : [];

  return { ok: true, branch: branch.slug, date: q.date, partySize: q.partySize, sittingMinutes: RULES.sittingMinutes(q.partySize), slots, matchedWindow, alternatives, reason };
}

/**
 * §5.5 step 8: the nearest 3 open starts at the other branch(es) that date, then the nearest 3 at this branch
 * over the next 2 days (sooner day first), skipping dates past the horizon. "Nearest" is to the preferred
 * time of day, else the requested window's opening, else the earliest start.
 */
function findAlternatives(bundle: AvailabilityBundle, branch: BranchRow, q: AvailabilityQuery, now: number): Slot[] {
  const targetMin = q.time ? minutesOf(q.time) : null;
  const rank = (slots: Slot[], date: LocalDate, zone: string) => {
    let pool = q.window && targetMin === null ? slots.filter((s) => s.service === q.window) : slots;
    if (!pool.length) pool = slots;
    if (targetMin === null) return [...pool].sort(chronological);
    return [...pool].sort(byNearness(instantAtMinutes(date, targetMin, zone)));
  };
  const out: Slot[] = [];
  for (const other of bundle.branches.filter((b) => b.id !== branch.id && b.isActive)) {
    if (!validateQuery(bundle, { branch: other.slug, date: q.date, partySize: q.partySize }, now).ok) continue;
    out.push(...rank(openStarts(bundle, other, q.date, q.partySize, now).open, q.date, other.timezone).slice(0, ALT_PER_GROUP).sort(chronological));
  }
  const later: Slot[] = [];
  for (let d = 1; d <= ALT_DAYS && later.length < ALT_PER_GROUP; d++) {
    const date = addLocalDays(q.date, d, branch.timezone);
    if (!validateQuery(bundle, { branch: branch.slug, date, partySize: q.partySize }, now).ok) continue;
    later.push(...rank(openStarts(bundle, branch, date, q.partySize, now).open, date, branch.timezone));
  }
  out.push(...later.slice(0, ALT_PER_GROUP).sort(chronological));
  return out;
}

/**
 * Alternatives for a query whose branch can't take it (review AV-2): the other active branch(es) on that date, and
 * this branch's next 2 days only if it is active.
 */
export function alternativesFor(bundle: AvailabilityBundle, q: AvailabilityQuery, now: number): Slot[] {
  const branch = bundle.branches.find((b) => b.slug === q.branch);
  return branch ? findAlternatives(bundle, branch, q, now) : [];
}

/** True if `startsAt` is an open grid start for this query right now (used by the booking re-validation). */
export function isOpenStart(bundle: AvailabilityBundle, branch: BranchRow, date: LocalDate, partySize: number, startsAt: number, now: number): boolean {
  return openStarts(bundle, branch, date, partySize, now).open.some((s) => s.startsAt === startsAt);
}

export type StartCheck =
  | { ok: true; branch: BranchRow; date: LocalDate; endsAt: number }
  | { ok: false; reason: "unknown_branch" | "branch_inactive" | "party_size" | "lead_time" | "past_horizon" | "closed" | "off_grid" | "blocked" | "full" };

/**
 * Re-validate one requested start with the engine's rules (§5.6 step 2). It says why a start can't be booked:
 * - `lead_time`: in the past or within 60 minutes;
 * - `closed`: the branch isn't serving at that time;
 * - `off_grid`: not on the 30-minute grid, or past the last seating;
 * - `blocked`: staff blocked this start (D-25);
 * - `full`: no free fitting table.
 */
export function checkStart(bundle: AvailabilityBundle, branchSlug: string, partySize: number, startsAt: number, now: number): StartCheck {
  const branch = bundle.branches.find((b) => b.slug === branchSlug);
  if (!branch) return { ok: false, reason: "unknown_branch" };
  if (!branch.isActive) return { ok: false, reason: "branch_inactive" };
  if (!Number.isInteger(partySize) || partySize < RULES.onlinePartyMin || partySize > RULES.onlinePartyMax) return { ok: false, reason: "party_size" };
  const date = localDateOfInstant(startsAt, branch.timezone);
  const offset = daysBetween(todayLocal(now, branch.timezone), date);
  if (offset < 0 || startsAt < now + RULES.leadMinutes * 60_000) return { ok: false, reason: "lead_time" };
  if (offset > RULES.horizonDays) return { ok: false, reason: "past_horizon" };
  const sitting = RULES.sittingMinutes(partySize);
  // Wall-clock minute of the start, verified by a round trip so seconds, DST gaps and repeated hours can't slip in.
  const minute = minutesOf(localTimeOfInstant(startsAt, branch.timezone));
  const windows = windowsFor(date, weekdayOf(date, branch.timezone), bundle.weekly.get(branch.id) ?? [], bundle.exceptions.get(branch.id) ?? []);
  const containing = windows.filter((w) => minute >= w.opensMin && minute < w.closesMin);
  if (!containing.length) return { ok: false, reason: "closed" };
  if (instantAtMinutes(date, minute, branch.timezone) !== startsAt) return { ok: false, reason: "off_grid" };
  if (!containing.some((w) => (minute - w.opensMin) % RULES.slotMinutes === 0 && minute + sitting <= w.closesMin)) return { ok: false, reason: "off_grid" };
  if (isBlocked(bundle, branch.id, date, timeOfMinutes(minute))) return { ok: false, reason: "blocked" };
  const endsAt = startsAt + sitting * 60_000;
  if (!pickTable(bundle, branch.id, partySize, startsAt, endsAt)) return { ok: false, reason: "full" };
  return { ok: true, branch, date, endsAt };
}
