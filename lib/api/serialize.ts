import type { Slot } from "@/lib/booking/availability";
import type { ReservationView } from "@/lib/booking/view";
import { RULES } from "@/lib/config";
import { dayLabel, isoInZone } from "@/lib/time/tz";

/** A slot on the wire: ISO time with the branch offset plus labels (§5.9). */
export function slotJson(s: Slot, zone: string = RULES.timezone) {
  return { branch: s.branch, date: s.date, time: s.time, service: s.service, startsAt: isoInZone(s.startsAt, zone), startsAtMs: s.startsAt, label: s.label, dateLabel: dayLabel(s.date, zone) };
}
export type SlotJson = ReturnType<typeof slotJson>;

/** A saved reservation as the confirmation card and admin list receive it. The guest's phone and email are never echoed. */
export function reservationJson(v: ReservationView, zone: string = RULES.timezone) {
  return { ...v, startsAtIso: isoInZone(v.startsAt, zone), endsAtIso: isoInZone(v.endsAt, zone) };
}
