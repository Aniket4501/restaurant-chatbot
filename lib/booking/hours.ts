import { minutesOf, type LocalDate } from "@/lib/time/tz";

export type Service = "lunch" | "dinner";
export const SERVICES: readonly Service[] = ["lunch", "dinner"];

export type WeeklyHours = { weekday: number; service: Service; opens: string; closes: string };
export type HoursException = { date: LocalDate; service: Service | null; isClosed: boolean; opens: string | null; closes: string | null; note: string | null };
export type ServiceWindow = { service: Service; opensMin: number; closesMin: number };

/**
 * Service windows for one branch-local date (§5.5 step 2). If any exception row exists for the date, those
 * rows replace ALL weekly rows for that date. A whole-day row (service null) can only be a closure. A service
 * the exception rows don't open is closed (the seed loader requires both services to be listed, D-08).
 */
export function windowsFor(date: LocalDate, weekday: number, weekly: WeeklyHours[], exceptions: HoursException[]): ServiceWindow[] {
  const ex = exceptions.filter((e) => e.date === date);
  const rows = ex.length
    ? ex.filter((e) => !e.isClosed && e.service && e.opens && e.closes).map((e) => ({ service: e.service as Service, opens: e.opens as string, closes: e.closes as string }))
    : weekly.filter((w) => w.weekday === weekday);
  return rows
    .map((r) => ({ service: r.service, opensMin: minutesOf(r.opens), closesMin: minutesOf(r.closes) }))
    .sort((a, b) => a.opensMin - b.opensMin);
}
