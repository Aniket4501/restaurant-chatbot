import { z } from "zod";
import { cancelReservation } from "@/lib/booking/cancel";
import { toView, VIEW_SELECT } from "@/lib/booking/view";
import { RULES } from "@/lib/config";
import { errorResponse, okResponse, readJson } from "@/lib/http/json";
import { formatPhone } from "@/lib/phone";
import { addLocalDays, isLocalDate, toInstant, todayLocal } from "@/lib/time/tz";
import type { ApiDeps } from "@/lib/api/deps";
import { reservationJson } from "@/lib/api/serialize";

const ListQuery = z.object({
  date: z.string().refine(isLocalDate, "YYYY-MM-DD").optional(),
  branch: z.string().min(1).max(64).optional(),
  status: z.enum(["all", "confirmed", "cancelled"]).optional(),
});

/** GET /api/admin/reservations?date&branch&status: the day's bookings sorted by time; totals count confirmed only (§5.9). */
export function adminListHandler(deps: ApiDeps) {
  return async (req: Request): Promise<Response> => {
    const q = ListQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) return errorResponse(400, "VALIDATION", "Please check the filters.", { fields: Object.fromEntries(q.error.issues.map((i) => [String(i.path[0]), i.message])) });
    const zone = RULES.timezone;
    const date = q.data.date ?? todayLocal(deps.now(), zone);
    const branch = q.data.branch && q.data.branch !== "all" ? q.data.branch : null;
    const status = q.data.status ?? "all";
    const from = toInstant(date, "00:00", zone);
    const to = toInstant(addLocalDays(date, 1, zone), "00:00", zone);
    const rows = deps
      .db()
      .prepare(
        `${VIEW_SELECT.replace("SELECT ", "SELECT r.phone_e164, r.email, r.note, ")}
         WHERE r.starts_at >= ? AND r.starts_at < ? AND (? IS NULL OR b.slug = ?) AND (? = 'all' OR r.status = ?)
         ORDER BY r.starts_at, b.slug, r.ref`,
      )
      .all(from, to, branch, branch, status, status) as (Parameters<typeof toView>[0] & { phone_e164: string; email: string | null; note: string | null })[];
    const items = rows.map((r) => ({ ...reservationJson(toView(r)), phone: r.phone_e164, phoneLabel: formatPhone(r.phone_e164), email: r.email, note: r.note }));
    const confirmed = items.filter((i) => i.status === "confirmed");
    const branches = deps.db().prepare("SELECT slug, name FROM branches WHERE is_active = 1 ORDER BY id").all();
    return okResponse(200, { date, branch: branch ?? "all", status, branches, items, totals: { confirmed: confirmed.length, covers: confirmed.reduce((s, i) => s + i.partySize, 0) } });
  };
}

const Patch = z.object({ status: z.literal("cancelled") });

/** PATCH /api/admin/reservations/:ref {status:'cancelled'}: idempotent staff cancel (BR-13). */
export function adminCancelHandler(deps: ApiDeps) {
  return async (req: Request, ctx: { params: Promise<{ ref: string }> }): Promise<Response> => {
    const body = await readJson(req);
    if (!body.ok) return body.response;
    if (!Patch.safeParse(body.value).success) return errorResponse(400, "VALIDATION", "Only status 'cancelled' is supported.", { fields: { status: "must be 'cancelled'" } });
    const { ref } = await ctx.params;
    const r = cancelReservation(deps.db(), ref, deps.now());
    if ("code" in r) return errorResponse(404, "NOT_FOUND", r.message);
    return okResponse(200, { reservation: reservationJson(r.reservation), changed: r.changed });
  };
}
