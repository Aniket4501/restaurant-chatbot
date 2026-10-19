import type { DB } from "@/lib/db/client";
import { dayLabelLong, localDateOf, localTimeOf, timeLabel } from "@/lib/time/tz";

/** What a confirmation card (and the admin list) shows; built from the saved row only (BR-12, G-3). */
export type ReservationView = {
  ref: string;
  status: "confirmed" | "cancelled";
  branch: { slug: string; name: string; address: string; phone: string };
  startsAt: number;
  endsAt: number;
  date: string;
  time: string;
  timeLabel: string;
  dateLabel: string;
  partySize: number;
  guestName: string;
  createdAt: number;
  cancelledAt: number | null;
};

type Row = {
  ref: string; status: "confirmed" | "cancelled"; slug: string; name: string; address: string; phone: string; timezone: string;
  starts_at: number; ends_at: number; party_size: number; guest_name: string; created_at: number; cancelled_at: number | null;
};

export const VIEW_SELECT = `SELECT r.ref, r.status, b.slug, b.name, b.address, b.phone, b.timezone, r.starts_at, r.ends_at, r.party_size,
  r.guest_name, r.created_at, r.cancelled_at FROM reservations r JOIN branches b ON b.id = r.branch_id`;

export function toView(r: Row): ReservationView {
  return {
    ref: r.ref,
    status: r.status,
    branch: { slug: r.slug, name: r.name, address: r.address, phone: r.phone },
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    date: localDateOf(r.starts_at, r.timezone),
    time: localTimeOf(r.starts_at, r.timezone),
    timeLabel: timeLabel(r.starts_at, r.timezone),
    dateLabel: dayLabelLong(localDateOf(r.starts_at, r.timezone), r.timezone),
    partySize: r.party_size,
    guestName: r.guest_name,
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
  };
}

export function viewByRef(db: DB, ref: string): ReservationView | null {
  const row = db.prepare(`${VIEW_SELECT} WHERE r.ref = ?`).get(ref) as Row | undefined;
  return row ? toView(row) : null;
}

export function viewByKey(db: DB, key: string): (ReservationView & { requestHash: string }) | null {
  const row = db.prepare(`${VIEW_SELECT.replace("SELECT ", "SELECT r.request_hash, ")} WHERE r.idempotency_key = ?`).get(key) as (Row & { request_hash: string }) | undefined;
  return row ? { ...toView(row), requestHash: row.request_hash } : null;
}
