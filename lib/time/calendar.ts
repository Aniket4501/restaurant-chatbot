import { addLocalDays, dayLabel, todayLocal, type LocalDate } from "@/lib/time/tz";

/** Branch-local dates from today to today + `days` (BR-06 horizon is 30 days, so 31 dates). */
export function horizonDates(now: number, zone: string, days: number): LocalDate[] {
  const today = todayLocal(now, zone);
  return Array.from({ length: days + 1 }, (_, i) => addLocalDays(today, i, zone));
}

/**
 * The prompt's 31-line calendar (§5.7), byte-compatible with probe prompt v2:
 * "Fri 16 Oct = 2026-10-16 (today)", "Sat 17 Oct = 2026-10-17 (tomorrow)", "Sun 18 Oct = 2026-10-18", …
 */
export function calendarLines(now: number, zone: string, days = 30): string[] {
  return horizonDates(now, zone, days).map(
    (d, i) => `${dayLabel(d, zone)} = ${d}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`,
  );
}
