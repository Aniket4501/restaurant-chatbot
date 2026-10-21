import type { DB } from "@/lib/db/client";
import type { HoursException, Service, WeeklyHours } from "@/lib/booking/hours";
import type { AvailabilityBundle } from "@/lib/booking/availability";
import { addLocalDays, instantAtMinutes, type LocalDate } from "@/lib/time/tz";

/**
 * Read one availability bundle (§5.5): every branch (alternatives may use the other one), their weekly hours,
 * the exceptions and confirmed bookings for `dates` plus the 2 alternative days after the last one, and all
 * tables. Inactive rows are included and filtered by the engine.
 */
export function loadAvailabilityData(db: DB, dates: LocalDate[]): AvailabilityBundle {
  const branches = (db.prepare("SELECT id, slug, name, timezone, is_active FROM branches ORDER BY id").all() as { id: number; slug: string; name: string; timezone: string; is_active: number }[]).map(
    (b) => ({ id: b.id, slug: b.slug, name: b.name, timezone: b.timezone, isActive: b.is_active === 1 }),
  );
  const zone = branches[0]?.timezone ?? "Asia/Kolkata";
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = addLocalDays(sorted[sorted.length - 1], 2, zone);
  const weekly = new Map<number, WeeklyHours[]>();
  for (const r of db.prepare("SELECT branch_id, weekday, service, opens, closes FROM service_hours").all() as (WeeklyHours & { branch_id: number })[]) {
    weekly.set(r.branch_id, [...(weekly.get(r.branch_id) ?? []), { weekday: r.weekday, service: r.service, opens: r.opens, closes: r.closes }]);
  }
  const exceptions = new Map<number, HoursException[]>();
  // One day of margin each side: a branch in another zone may be on a neighbouring calendar date (review AV-3).
  for (const r of db.prepare("SELECT branch_id, date, service, is_closed, opens, closes, note FROM hours_exceptions WHERE date BETWEEN ? AND ?").all(addLocalDays(first, -1, zone), addLocalDays(last, 1, zone)) as {
    branch_id: number; date: string; service: Service | null; is_closed: number; opens: string | null; closes: string | null; note: string | null;
  }[]) {
    exceptions.set(r.branch_id, [...(exceptions.get(r.branch_id) ?? []), { date: r.date, service: r.service, isClosed: r.is_closed === 1, opens: r.opens, closes: r.closes, note: r.note }]);
  }
  const tables = (db.prepare("SELECT id, branch_id, label, min_seats, max_seats, is_active FROM dining_tables").all() as { id: number; branch_id: number; label: string; min_seats: number; max_seats: number; is_active: number }[]).map(
    (t) => ({ id: t.id, branchId: t.branch_id, label: t.label, minSeats: t.min_seats, maxSeats: t.max_seats, isActive: t.is_active === 1 }),
  );
  // One day of margin on each side covers sittings that cross midnight in any branch zone.
  const from = instantAtMinutes(addLocalDays(first, -1, zone), 0, zone);
  const to = instantAtMinutes(addLocalDays(last, 2, zone), 0, zone);
  const bookings = (db.prepare("SELECT table_id, starts_at, ends_at FROM reservations WHERE status = 'confirmed' AND starts_at < ? AND ends_at > ?").all(to, from) as { table_id: number; starts_at: number; ends_at: number }[]).map(
    (b) => ({ tableId: b.table_id, startsAt: b.starts_at, endsAt: b.ends_at }),
  );
  // Staff slot blocks (D-25), with the same date margin as the exceptions.
  const blocks = new Map<number, Set<string>>();
  for (const r of db.prepare("SELECT branch_id, date, time FROM slot_blocks WHERE date BETWEEN ? AND ?").all(addLocalDays(first, -1, zone), addLocalDays(last, 1, zone)) as { branch_id: number; date: string; time: string }[]) {
    blocks.set(r.branch_id, (blocks.get(r.branch_id) ?? new Set()).add(`${r.date}|${r.time}`));
  }
  return { branches, weekly, exceptions, tables, bookings, blocks };
}
