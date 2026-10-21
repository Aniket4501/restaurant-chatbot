import { z } from "zod";
import { RULES } from "@/lib/config";
import type { DB } from "@/lib/db/client";
import { branchShortName } from "@/lib/kb/facts";
import { formatPhone } from "@/lib/phone";
import { addLocalDays, dayLabelLong, isLocalDate, localDateOf, timeLabel, toInstant, todayLocal } from "@/lib/time/tz";
import { notFound, parse } from "@/lib/admin/common";

// The staff bookings list and booking details (D-25; the list was lib/api/admin.ts, D-16). The list shows what staff
// need at a glance and no more: the guest's name, a masked mobile number and whether there is a note. The full number,
// the email and the note are in the details view only. Search by name or reference looks across all dates.

export const BookingsQuery = z.object({
  date: z.string().refine(isLocalDate, "YYYY-MM-DD").optional(),
  branch: z.string().min(1).max(64).optional(),
  status: z.enum(["all", "confirmed", "cancelled"]).optional(),
  q: z.string().max(80).optional(),
});

export type BookingListItem = {
  ref: string;
  status: "confirmed" | "cancelled";
  branch: { slug: string; name: string };
  date: string;
  dateLabel: string;
  timeLabel: string;
  startsAt: number;
  partySize: number;
  guestName: string;
  phoneMasked: string;
  hasNote: boolean;
};

/** "+91 98765 43210" → "+91 98••• ••210": enough to tell two guests apart, not enough to call them. */
export function maskPhone(e164: string): string {
  const label = formatPhone(e164);
  const digits = [...label].filter((c) => /\d/.test(c)).length;
  let seen = 0;
  return [...label]
    .map((c) => {
      if (!/\d/.test(c)) return c;
      seen++;
      return seen <= 4 || seen > digits - 3 ? c : "•";
    })
    .join("");
}

type Row = { ref: string; status: "confirmed" | "cancelled"; slug: string; name: string; timezone: string; starts_at: number; ends_at: number; party_size: number; guest_name: string; phone_e164: string; note: string | null };

const SELECT = `SELECT r.ref, r.status, b.slug, b.name, b.timezone, r.starts_at, r.ends_at, r.party_size, r.guest_name, r.phone_e164, r.note
  FROM reservations r JOIN branches b ON b.id = r.branch_id`;

const toItem = (r: Row): BookingListItem => ({
  ref: r.ref,
  status: r.status,
  branch: { slug: r.slug, name: r.name },
  date: localDateOf(r.starts_at, r.timezone),
  dateLabel: dayLabelLong(localDateOf(r.starts_at, r.timezone), r.timezone),
  timeLabel: timeLabel(r.starts_at, r.timezone),
  startsAt: r.starts_at,
  partySize: r.party_size,
  guestName: r.guest_name,
  phoneMasked: maskPhone(r.phone_e164),
  hasNote: !!r.note,
});

export type BookingList = {
  mode: "day" | "search";
  date: string;
  branch: string;
  status: "all" | "confirmed" | "cancelled";
  q: string | null;
  branches: { slug: string; name: string }[];
  items: BookingListItem[];
  /** Over the day and branch, whatever the status filter: confirmed bookings, their guests, and cancellations. */
  totals: { confirmed: number; covers: number; cancelled: number };
  /** Search only: more matches than shown. */
  truncated: boolean;
};

const SEARCH_LIMIT = 50;

export function listBookings(db: DB, now: number, raw: unknown): BookingList {
  const q = parse(BookingsQuery, raw);
  const zone = RULES.timezone;
  const date = q.date ?? todayLocal(now, zone);
  const branch = q.branch && q.branch !== "all" ? q.branch : null;
  const status = q.status ?? "all";
  const search = q.q?.trim().replace(/\s+/g, " ") ?? "";
  const branches = db.prepare("SELECT slug, name FROM branches WHERE is_active = 1 ORDER BY id").all() as { slug: string; name: string }[];
  if (search.length >= 2) {
    // Name (any part, case-insensitive) or reference ("NE-AB12CD34", with or without "NE-"); LIKE wildcards escaped.
    const like = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const ref = search.toUpperCase().replace(/^NE-?/, "");
    const rows = db
      .prepare(
        `${SELECT} WHERE (lower(r.guest_name) LIKE ? ESCAPE '\\' OR r.ref LIKE ? ESCAPE '\\') AND (? IS NULL OR b.slug = ?) AND (? = 'all' OR r.status = ?)
         ORDER BY CASE WHEN r.starts_at >= ? THEN 0 ELSE 1 END, CASE WHEN r.starts_at >= ? THEN r.starts_at ELSE -r.starts_at END LIMIT ?`,
      )
      .all(like, `NE-%${ref.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, branch, branch, status, status, now, now, SEARCH_LIMIT + 1) as Row[];
    const items = rows.slice(0, SEARCH_LIMIT).map(toItem);
    const confirmed = items.filter((i) => i.status === "confirmed");
    return { mode: "search", date, branch: branch ?? "all", status, q: search, branches, items, totals: { confirmed: confirmed.length, covers: confirmed.reduce((n, i) => n + i.partySize, 0), cancelled: items.length - confirmed.length }, truncated: rows.length > SEARCH_LIMIT };
  }
  const from = toInstant(date, "00:00", zone);
  const to = toInstant(addLocalDays(date, 1, zone), "00:00", zone);
  const day = db.prepare(`${SELECT} WHERE r.starts_at >= ? AND r.starts_at < ? AND (? IS NULL OR b.slug = ?) ORDER BY r.starts_at, b.slug, r.ref`).all(from, to, branch, branch) as Row[];
  const all = day.map(toItem);
  const confirmed = all.filter((i) => i.status === "confirmed");
  return {
    mode: "day",
    date,
    branch: branch ?? "all",
    status,
    q: null,
    branches,
    items: status === "all" ? all : all.filter((i) => i.status === status),
    totals: { confirmed: confirmed.length, covers: confirmed.reduce((n, i) => n + i.partySize, 0), cancelled: all.length - confirmed.length },
    truncated: false,
  };
}

export type BookingDetail = BookingListItem & {
  branchShortName: string;
  endLabel: string;
  sittingMinutes: number;
  phoneLabel: string;
  email: string | null;
  note: string | null;
  table: string;
  source: string;
  createdLabel: string;
  cancelledLabel: string | null;
};

export function bookingDetail(db: DB, ref: string): BookingDetail {
  const r = db
    .prepare(`SELECT r.ref, r.status, b.slug, b.name, b.timezone, r.starts_at, r.ends_at, r.party_size, r.guest_name, r.phone_e164, r.note, r.email, r.source, r.created_at, r.cancelled_at, t.label AS table_label
      FROM reservations r JOIN branches b ON b.id = r.branch_id JOIN dining_tables t ON t.id = r.table_id WHERE r.ref = ?`)
    .get(ref) as (Row & { email: string | null; source: string; created_at: number; cancelled_at: number | null; table_label: string }) | undefined;
  if (!r) throw notFound("Booking");
  const at = (t: number) => `${dayLabelLong(localDateOf(t, r.timezone), r.timezone)}, ${timeLabel(t, r.timezone)}`;
  return {
    ...toItem(r),
    branchShortName: branchShortName(r.name),
    endLabel: timeLabel(r.ends_at, r.timezone),
    sittingMinutes: Math.round((r.ends_at - r.starts_at) / 60_000),
    phoneLabel: formatPhone(r.phone_e164),
    email: r.email,
    note: r.note,
    table: r.table_label,
    source: r.source === "chat" ? "Chatbot" : r.source,
    createdLabel: at(r.created_at),
    cancelledLabel: r.cancelled_at ? at(r.cancelled_at) : null,
  };
}
