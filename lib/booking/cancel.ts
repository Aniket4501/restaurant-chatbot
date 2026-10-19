import type { DB } from "@/lib/db/client";
import { immediate } from "@/lib/db/tx";
import { MESSAGES } from "@/lib/booking/errors";
import { viewByRef, type ReservationView } from "@/lib/booking/view";

/** Staff cancel (BR-13): idempotent. Cancelling a cancelled booking returns it unchanged. The slot reopens at once. */
export function cancelReservation(db: DB, ref: string, now: number): { status: 200; reservation: ReservationView; changed: boolean } | { code: "NOT_FOUND"; status: 404; message: string } {
  return immediate(db, () => {
    const row = db.prepare("SELECT status FROM reservations WHERE ref = ?").get(ref) as { status: string } | undefined;
    if (!row) return { code: "NOT_FOUND" as const, status: 404 as const, message: MESSAGES.NOT_FOUND };
    const changed = row.status === "confirmed";
    if (changed) db.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = ? WHERE ref = ?").run(now, ref);
    return { status: 200 as const, reservation: viewByRef(db, ref)!, changed };
  });
}
