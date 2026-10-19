import fs from "node:fs";
import path from "node:path";
import type { AvailabilityBundle, BookingInterval } from "@/lib/booking/availability";
import type { HoursException, WeeklyHours } from "@/lib/booking/hours";
import { DAY_KEYS, toInstant } from "@/lib/time/tz";
import { RULES } from "@/lib/config";

type Fixture = {
  branches: { slug: string; name: string; timezone: string; isActive: boolean }[];
  hours: { branch: string; days: string[]; service: "lunch" | "dinner"; opens: string; closes: string }[];
  exceptions: { branch: string; date: string; service: "lunch" | "dinner" | null; isClosed: boolean; opens: string | null; closes: string | null; note: string | null }[];
  tables: { branch: string; label: string; minSeats: number; maxSeats: number }[];
};

export const FIXTURE: Fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8"));

/** Build an availability bundle straight from evals/fixtures/base.json (absolute dates), without a DB. */
export function fixtureBundle(over: { inactiveBranches?: string[] } = {}): AvailabilityBundle & { tableId: (branch: string, label: string) => number } {
  const branches = FIXTURE.branches.map((b, i) => ({ id: i + 1, slug: b.slug, name: b.name, timezone: b.timezone, isActive: !(over.inactiveBranches ?? []).includes(b.slug) }));
  const idOf = (slug: string) => branches.find((b) => b.slug === slug)!.id;
  const weekly = new Map<number, WeeklyHours[]>();
  for (const h of FIXTURE.hours)
    for (const d of h.days) weekly.set(idOf(h.branch), [...(weekly.get(idOf(h.branch)) ?? []), { weekday: DAY_KEYS.indexOf(d as (typeof DAY_KEYS)[number]), service: h.service, opens: h.opens, closes: h.closes }]);
  const exceptions = new Map<number, HoursException[]>();
  for (const e of FIXTURE.exceptions)
    exceptions.set(idOf(e.branch), [...(exceptions.get(idOf(e.branch)) ?? []), { date: e.date, service: e.service, isClosed: e.isClosed, opens: e.opens, closes: e.closes, note: e.note }]);
  const tables = FIXTURE.tables.map((t, i) => ({ id: i + 1, branchId: idOf(t.branch), label: t.label, minSeats: t.minSeats, maxSeats: t.maxSeats, isActive: true }));
  const tableId = (branch: string, label: string) => tables.find((t) => t.branchId === idOf(branch) && t.label === label)!.id;
  return { branches, weekly, exceptions, tables, bookings: [], tableId };
}

/** A confirmed booking interval on a table for a party's sitting starting at local date/time. */
export function bookingAt(bundle: ReturnType<typeof fixtureBundle>, branch: string, label: string, date: string, time: string, party: number): BookingInterval {
  const startsAt = toInstant(date, time, "Asia/Kolkata");
  return { tableId: bundle.tableId(branch, label), startsAt, endsAt: startsAt + RULES.sittingMinutes(party) * 60_000 };
}
