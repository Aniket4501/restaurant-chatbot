// Request checks for proxy.ts (D-16, D-22), as a pure function so it is unit-tested without Next.
// 1. Host must be loopback (blocks DNS rebinding to 127.0.0.1).
// 2. State-changing requests need an Origin equal to the app's own origin (blocks other local ports and sites, so no
//    other page can cancel a booking or start an eval run).
// The staff pages and their APIs need no password (D-22: the app is a local demo bound to 127.0.0.1).

export type ProxyInput = { method: string; host: string | null; origin: string | null };
export type ProxyDecision = { action: "next" } | { action: "deny"; status: 403; code: "BAD_REQUEST"; message: string };

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const SAFE = new Set(["GET", "HEAD"]);

export function decide(req: ProxyInput): ProxyDecision {
  if (!req.host || !LOOPBACK_HOST.test(req.host)) return { action: "deny", status: 403, code: "BAD_REQUEST", message: "Forbidden host." };
  if (!SAFE.has(req.method) && req.origin !== `http://${req.host}`) return { action: "deny", status: 403, code: "BAD_REQUEST", message: "Cross-origin request refused." };
  return { action: "next" };
}
