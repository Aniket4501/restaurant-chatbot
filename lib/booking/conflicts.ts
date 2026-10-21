import type { DB } from "@/lib/db/client";
import { windowsFor, type HoursException, type Service, type WeeklyHours } from "@/lib/booking/hours";
import { instantAtMinutes, localDateOf, weekdayOf } from "@/lib/time/tz";

// Bookings the current hours, exceptions, tables and branches no longer support (D-14 reseed check; D-25 staff edits).
// A change that would add conflicts is refused unless staff confirm it; the bookings themselves are never changed.

export type SeedConflict = { ref: string; branch: string; startsAt: number; reason: "table_inactive" | "table_size" | "outside_hours" };

/** Confirmed bookings from `now` on that the current tables, hours and exceptions no longer support. */
export function findConflicts(db: DB, now: number): SeedConflict[] {
  const rows = db
    .prepare(`SELECT r.ref, r.branch_id, r.party_size, r.starts_at, r.ends_at, b.slug, b.timezone, b.is_active AS branch_active,
        t.is_active AS table_active, t.min_seats, t.max_seats
      FROM reservations r JOIN branches b ON b.id = r.branch_id JOIN dining_tables t ON t.id = r.table_id
      WHERE r.status = 'confirmed' AND r.ends_at > ?`)
    .all(now) as {
    ref: string; branch_id: number; party_size: number; starts_at: number; ends_at: number; slug: string; timezone: string;
    branch_active: number; table_active: number; min_seats: number; max_seats: number;
  }[];
  const weeklyStmt = db.prepare("SELECT weekday, service, opens, closes FROM service_hours WHERE branch_id = ?");
  const exStmt = db.prepare("SELECT date, service, is_closed, opens, closes, note FROM hours_exceptions WHERE branch_id = ? AND date = ?");
  const out: SeedConflict[] = [];
  for (const r of rows) {
    const base = { ref: r.ref, branch: r.slug, startsAt: r.starts_at };
    if (!r.table_active || !r.branch_active) {
      out.push({ ...base, reason: "table_inactive" });
      continue;
    }
    if (r.party_size < r.min_seats || r.party_size > r.max_seats) {
      out.push({ ...base, reason: "table_size" });
      continue;
    }
    const date = localDateOf(r.starts_at, r.timezone);
    const weekly = weeklyStmt.all(r.branch_id) as WeeklyHours[];
    const ex = (exStmt.all(r.branch_id, date) as { date: string; service: Service | null; is_closed: number; opens: string | null; closes: string | null; note: string | null }[]).map(
      (e): HoursException => ({ date: e.date, service: e.service, isClosed: e.is_closed === 1, opens: e.opens, closes: e.closes, note: e.note }),
    );
    const midnight = instantAtMinutes(date, 0, r.timezone);
    const startMin = (r.starts_at - midnight) / 60_000;
    const endMin = (r.ends_at - midnight) / 60_000;
    const fits = windowsFor(date, weekdayOf(date, r.timezone), weekly, ex).some((w) => startMin >= w.opensMin && endMin <= w.closesMin);
    if (!fits) out.push({ ...base, reason: "outside_hours" });
  }
  return out;
}


/** Conflicts in `after` that weren't in `before` (by reference and reason): what an edit would newly cause. */
export function newConflicts(before: SeedConflict[], after: SeedConflict[]): SeedConflict[] {
  const had = new Set(before.map((c) => `${c.ref}|${c.reason}`));
  return after.filter((c) => !had.has(`${c.ref}|${c.reason}`));
}
