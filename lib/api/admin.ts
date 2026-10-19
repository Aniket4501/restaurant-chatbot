import { z } from "zod";
import { cancelReservation } from "@/lib/booking/cancel";
import { toView, VIEW_SELECT } from "@/lib/booking/view";
import { loadAdminSecrets, RULES } from "@/lib/config";
import { clearedCookie, issueSession, passwordMatches, readCookie, rotateEpoch, sessionCookie, verifySession } from "@/lib/auth/admin-session";
import { errorResponse, okResponse, readJson } from "@/lib/http/json";
import { addLocalDays, isLocalDate, toInstant, todayLocal } from "@/lib/time/tz";
import type { ApiDeps } from "@/lib/api/deps";
import { reservationJson } from "@/lib/api/serialize";

/**
 * Full admin check for every admin handler (D-16): configured secrets (else 503, log names variables only) and a
 * signed, unexpired cookie from the current epoch (else 401).
 */
export function requireAdmin(req: Request, deps: ApiDeps): { ok: true; key: Buffer } | { ok: false; response: Response } {
  const secrets = loadAdminSecrets(deps.adminEnv());
  if (!secrets.ok) {
    console.warn(`admin disabled: ${secrets.problems.join("; ")}`);
    return { ok: false, response: errorResponse(503, "UNAVAILABLE", "Admin isn't configured on this server.") };
  }
  if (!verifySession(readCookie(req.headers.get("cookie")), secrets.secretKey, deps.now())) return { ok: false, response: errorResponse(401, "UNAUTHENTICATED", "Please sign in.") };
  return { ok: true, key: secrets.secretKey };
}

const Login = z.object({ password: z.string().min(1).max(256) });

/** POST /api/admin/session (sign in, 5 attempts/min) and DELETE (sign out, revokes every earlier cookie). */
export function adminSessionHandlers(deps: ApiDeps) {
  return {
    POST: async (req: Request): Promise<Response> => {
      const secrets = loadAdminSecrets(deps.adminEnv());
      if (!secrets.ok) {
        console.warn(`admin disabled: ${secrets.problems.join("; ")}`);
        return errorResponse(503, "UNAVAILABLE", "Admin isn't configured on this server.");
      }
      // Per socket address; on a 127.0.0.1-only server every client shares one bucket (documented, D-14).
      const limited = deps.limits.adminLogin.hit("loopback", deps.now());
      if (!limited.ok) return errorResponse(429, "RATE_LIMITED", "Too many sign-in attempts. Please wait a minute.", {}, { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) });
      const body = await readJson(req);
      if (!body.ok) return body.response;
      const parsed = Login.safeParse(body.value);
      if (!parsed.success || !passwordMatches(parsed.data.password, secrets.password)) return errorResponse(401, "UNAUTHENTICATED", "Wrong password.");
      return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(issueSession(secrets.secretKey, deps.now())), "cache-control": "no-store" } });
    },
    DELETE: async (): Promise<Response> => {
      rotateEpoch();
      return new Response(null, { status: 204, headers: { "set-cookie": clearedCookie(), "cache-control": "no-store" } });
    },
  };
}

const ListQuery = z.object({
  date: z.string().refine(isLocalDate, "YYYY-MM-DD").optional(),
  branch: z.string().min(1).max(64).optional(),
  status: z.enum(["all", "confirmed", "cancelled"]).optional(),
});

/** GET /api/admin/reservations?date&branch&status: the day's bookings sorted by time; totals count confirmed only (§5.9). */
export function adminListHandler(deps: ApiDeps) {
  return async (req: Request): Promise<Response> => {
    const auth = requireAdmin(req, deps);
    if (!auth.ok) return auth.response;
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
    const items = rows.map((r) => ({ ...reservationJson(toView(r)), phone: r.phone_e164, email: r.email, note: r.note }));
    const confirmed = items.filter((i) => i.status === "confirmed");
    const branches = deps.db().prepare("SELECT slug, name FROM branches WHERE is_active = 1 ORDER BY id").all();
    return okResponse(200, { date, branch: branch ?? "all", status, branches, items, totals: { confirmed: confirmed.length, covers: confirmed.reduce((s, i) => s + i.partySize, 0) } });
  };
}

const Patch = z.object({ status: z.literal("cancelled") });

/** PATCH /api/admin/reservations/:ref {status:'cancelled'}: idempotent staff cancel (BR-13). */
export function adminCancelHandler(deps: ApiDeps) {
  return async (req: Request, ctx: { params: Promise<{ ref: string }> }): Promise<Response> => {
    const auth = requireAdmin(req, deps);
    if (!auth.ok) return auth.response;
    const body = await readJson(req);
    if (!body.ok) return body.response;
    if (!Patch.safeParse(body.value).success) return errorResponse(400, "VALIDATION", "Only status 'cancelled' is supported.", { fields: { status: "must be 'cancelled'" } });
    const { ref } = await ctx.params;
    const r = cancelReservation(deps.db(), ref, deps.now());
    if ("code" in r) return errorResponse(404, "NOT_FOUND", r.message);
    return okResponse(200, { reservation: reservationJson(r.reservation), changed: r.changed });
  };
}
