import { createReservation } from "@/lib/booking/create";
import { errorResponse, okResponse, readJson } from "@/lib/http/json";
import { normalizeIndianMobile } from "@/lib/phone";
import type { ApiDeps } from "@/lib/api/deps";
import { reservationJson, slotJson } from "@/lib/api/serialize";

/**
 * POST /api/reservations with header Idempotency-Key (UUID) → 201 created / 200 replay / 400 / 409 / 413 / 422 / 429 / 503
 * (§5.9, D-14). A confirmation is only ever built from the `reservation` in a 201/200 body (BR-12).
 */
export function reservationsHandler(deps: ApiDeps) {
  return async (req: Request): Promise<Response> => {
    const body = await readJson(req);
    if (!body.ok) return body.response;
    const key = req.headers.get("idempotency-key") ?? "";
    const now = deps.now();

    // Rate limits (D-14): a global cap, plus 5 creates per minute per normalised phone. Replays of a known key
    // still count, which is fine at these limits.
    const g = deps.limits.createsGlobal.hit("global", now);
    const raw = body.value as { phone?: unknown } | null;
    const phone = typeof raw?.phone === "string" ? normalizeIndianMobile(raw.phone) : null;
    const p = phone ? deps.limits.createsPerPhone.hit(phone, now) : ({ ok: true } as const);
    if (!g.ok || !p.ok) {
      const retry = Math.ceil(Math.max(g.ok ? 0 : g.retryAfterMs, p.ok ? 0 : p.retryAfterMs) / 1000);
      return errorResponse(429, "RATE_LIMITED", "Too many booking attempts. Please wait a moment.", {}, { "retry-after": String(retry) });
    }

    // An error opening the database happens before any write, so it is "nothing booked, try again" (503). One later on
    // may come after the row was committed, so it is reported as unknown (500), which the client retries with the same
    // key to learn the outcome (D-24 audit: the handler threw and Next answered 500 with no body).
    let db: ReturnType<ApiDeps["db"]>;
    try {
      db = deps.db();
    } catch (e) {
      console.error(JSON.stringify({ event: "reservation_error", stage: "open", code: (e as { code?: string }).code ?? (e as Error).name }));
      return errorResponse(503, "UNAVAILABLE", "We couldn't reach the booking system. Nothing was booked; please try again.", {}, { "retry-after": "1" });
    }
    let r: ReturnType<typeof createReservation>;
    try {
      r = createReservation(db, body.value, key, now);
    } catch (e) {
      console.error(JSON.stringify({ event: "reservation_error", stage: "create", code: (e as { code?: string }).code ?? (e as Error).name }));
      return errorResponse(500, "INTERNAL", "We couldn't confirm whether your booking was saved. Tap Retry to check.");
    }
    if ("reservation" in r) return okResponse(r.status, { reservation: reservationJson(r.reservation) });
    switch (r.code) {
      case "VALIDATION":
        return errorResponse(400, r.code, r.message, { fields: r.fields });
      case "SLOT_TAKEN":
        return errorResponse(409, r.code, r.message, { alternatives: r.alternatives.map((s) => slotJson(s)) });
      case "SLOT_UNAVAILABLE":
        return errorResponse(409, r.code, r.message, { reason: r.reason, alternatives: r.alternatives.map((s) => slotJson(s)) });
      case "DUPLICATE_BOOKING":
        return errorResponse(409, r.code, r.message, { existing: r.existing });
      case "IDEMPOTENCY_MISMATCH":
        return errorResponse(422, r.code, r.message);
      case "UNAVAILABLE":
        return errorResponse(503, r.code, r.message, {}, { "retry-after": "1" });
      default:
        return errorResponse(500, "BAD_REQUEST", "Unexpected error. Nothing was booked.");
    }
  };
}
