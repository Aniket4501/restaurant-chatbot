import { TZDate, tz } from "@date-fns/tz";
import { addDays, format, getDay } from "date-fns";

// Branch-local calendar math (D-09). Rules:
// - instants are epoch ms (UTC); branch-local dates are "YYYY-MM-DD" and times are zero-padded "HH:MM"
// - TZDate is built from numeric parts only (a string is read in the *process* zone, DT-02)
// - every date-fns call gets { in: tz(zone) }, so results never depend on process.env.TZ
// - inputs are validated first, because invalid parts roll over silently (DT-03)

export type LocalDate = string;
export type LocalTime = string;

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isLocalDate(s: unknown): s is LocalDate {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** "HH:MM", 00:00–23:59. (Closing time 24:00 is allowed only in hours data, via minutesOf.) */
export function isLocalTime(s: unknown): s is LocalTime {
  return typeof s === "string" && TIME_RE.test(s);
}

function parts(date: LocalDate): [number, number, number] {
  if (!isLocalDate(date)) throw new RangeError(`invalid local date: ${String(date)}`);
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/** Minutes since midnight for "HH:MM" (accepts "24:00" for closing times). */
export function minutesOf(time: string): number {
  if (time === "24:00") return 1440;
  if (!isLocalTime(time)) throw new RangeError(`invalid local time: ${String(time)}`);
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function timeOfMinutes(min: number): LocalTime {
  if (!Number.isInteger(min) || min < 0 || min >= 1440) throw new RangeError(`minutes out of range: ${min}`);
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** The instant of a branch-local date and time. */
export function toInstant(date: LocalDate, time: LocalTime, zone: string): number {
  const [y, m, d] = parts(date);
  const min = minutesOf(time);
  return new TZDate(y, m - 1, d, Math.floor(min / 60), min % 60, zone).getTime();
}

/** The instant at a number of minutes after local midnight (handles 24:00 = next midnight). */
export function instantAtMinutes(date: LocalDate, minutes: number, zone: string): number {
  const [y, m, d] = parts(date);
  return new TZDate(y, m - 1, d, 0, 0, zone).getTime() + minutes * 60_000;
}

export function localDateOf(instant: number, zone: string): LocalDate {
  return format(instant, "yyyy-MM-dd", { in: tz(zone) });
}

export function localTimeOf(instant: number, zone: string): LocalTime {
  return format(instant, "HH:mm", { in: tz(zone) });
}

/** 0 = Sunday … 6 = Saturday, for the branch-local calendar date (§5.4). */
export function weekdayOf(date: LocalDate, zone: string): number {
  const [y, m, d] = parts(date);
  return getDay(new TZDate(y, m - 1, d, 12, 0, zone));
}

export function dayKeyOf(date: LocalDate, zone: string): DayKey {
  return DAY_KEYS[weekdayOf(date, zone)];
}

/** Add calendar days in the branch zone (noon anchor, so DST shifts never change the date). */
export function addLocalDays(date: LocalDate, days: number, zone: string): LocalDate {
  const [y, m, d] = parts(date);
  return format(addDays(new TZDate(y, m - 1, d, 12, 0, zone), days), "yyyy-MM-dd", { in: tz(zone) });
}

/** Whole calendar days from a to b (b − a), both branch-local dates. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function todayLocal(now: number, zone: string): LocalDate {
  return localDateOf(now, zone);
}

/** "7:30 PM" for an instant in the branch zone. */
export function timeLabel(instant: number, zone: string): string {
  return format(instant, "h:mm a", { in: tz(zone) });
}

/** "7:30 PM" for a local "HH:MM" (or "24:00" → "12:00 AM"). */
export function timeLabelOf(time: string): string {
  const min = minutesOf(time) % 1440;
  const h = Math.floor(min / 60);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(min % 60).padStart(2, "0")} ${suffix}`;
}

/** "Fri 23 Oct" for a branch-local date. */
export function dayLabel(date: LocalDate, zone: string): string {
  const [y, m, d] = parts(date);
  return format(new TZDate(y, m - 1, d, 12, 0, zone), "EEE d MMM", { in: tz(zone) });
}

/** "Fri 23 Oct 2026" for a branch-local date. */
export function dayLabelLong(date: LocalDate, zone: string): string {
  const [y, m, d] = parts(date);
  return format(new TZDate(y, m - 1, d, 12, 0, zone), "EEE d MMM yyyy", { in: tz(zone) });
}

/** "Fri 16 Oct 2026, 2:05 PM, Asia/Kolkata" (the prompt's current-time line, §5.7). */
export function nowLine(now: number, zone: string): string {
  return `${format(now, "EEE d MMM yyyy, h:mm a", { in: tz(zone) })}, ${zone}`;
}

/** ISO 8601 with the branch offset, e.g. "2026-10-17T20:00:00+05:30" (§5.9 "times as ISO with offset"). */
export function isoInZone(instant: number, zone: string): string {
  return format(instant, "yyyy-MM-dd'T'HH:mm:ssXXX", { in: tz(zone) });
}
