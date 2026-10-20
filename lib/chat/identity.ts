import { windowsFor } from "@/lib/booking/hours";
import type { DB } from "@/lib/db/client";
import { branchShortName } from "@/lib/kb/facts";
import { formatPhone } from "@/lib/phone";
import { dayLabelLong, localTimeOf, minutesOf, timeLabelOf, todayLocal, weekdayOf } from "@/lib/time/tz";
import type { SubmitBranch } from "@/lib/chat/submit";

// The guest page's identity panel (§5.10): name, branches and today's hours, read from the database (BR-14) with the
// server's clock (D-12), never the browser's.

export type OpenStatus = { open: boolean; text: string };
export type BranchToday = SubmitBranch & { address: string; phone: string; todayLabel: string; services: { service: "lunch" | "dinner"; hours: string | null }[]; note: string | null; status: OpenStatus };

const minuteLabel = (m: number) => timeLabelOf(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

/**
 * Whether a branch is open at `nowMin` (minutes since local midnight) from today's service windows (exceptions already
 * applied): "Open now · until 3:30 PM", "Opens at 7:00 PM", "Closed for today" after the last service, "Closed today".
 */
export function openStatus(windows: { opensMin: number; closesMin: number }[], nowMin: number): OpenStatus {
  const sorted = [...windows].sort((a, b) => a.opensMin - b.opensMin);
  const current = sorted.find((w) => nowMin >= w.opensMin && nowMin < w.closesMin);
  if (current) return { open: true, text: `Open now · until ${minuteLabel(current.closesMin)}` };
  const next = sorted.find((w) => w.opensMin > nowMin);
  if (next) return { open: false, text: `Opens at ${minuteLabel(next.opensMin)}` };
  return { open: false, text: sorted.length ? "Closed for today" : "Closed today" };
}
export type Identity = { name: string; cuisine: string; branches: BranchToday[] };

export function loadIdentity(db: DB, now: number): Identity {
  const r = db.prepare("SELECT name, cuisine FROM restaurant WHERE id = 1").get() as { name: string; cuisine: string } | undefined;
  const branches = db.prepare("SELECT id, slug, name, address, phone, timezone FROM branches WHERE is_active = 1 ORDER BY id").all() as { id: number; slug: string; name: string; address: string; phone: string; timezone: string }[];
  return {
    name: r?.name ?? "Neem & Ember",
    cuisine: r?.cuisine ?? "",
    branches: branches.map((b) => {
      const today = todayLocal(now, b.timezone);
      const weekly = db.prepare("SELECT weekday, service, opens, closes FROM service_hours WHERE branch_id = ?").all(b.id) as { weekday: number; service: "lunch" | "dinner"; opens: string; closes: string }[];
      const ex = (db.prepare("SELECT date, service, is_closed, opens, closes, note FROM hours_exceptions WHERE branch_id = ? AND date = ?").all(b.id, today) as { date: string; service: "lunch" | "dinner" | null; is_closed: number; opens: string | null; closes: string | null; note: string | null }[]).map(
        (e) => ({ date: e.date, service: e.service, isClosed: e.is_closed === 1, opens: e.opens, closes: e.closes, note: e.note }),
      );
      const windows = windowsFor(today, weekdayOf(today, b.timezone), weekly, ex);
      return {
        slug: b.slug,
        name: b.name,
        short: branchShortName(b.name),
        address: b.address,
        phone: b.phone,
        phoneLabel: formatPhone(b.phone),
        todayLabel: dayLabelLong(today, b.timezone),
        services: (["lunch", "dinner"] as const).map((service) => {
          const w = windows.find((x) => x.service === service);
          return { service, hours: w ? `${minuteLabel(w.opensMin)}–${minuteLabel(w.closesMin)}` : null };
        }),
        note: [...new Set(ex.map((e) => e.note).filter(Boolean))].join("; ") || null,
        status: openStatus(windows, minutesOf(localTimeOf(now, b.timezone))),
      };
    }),
  };
}
