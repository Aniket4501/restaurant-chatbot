import { verifySession } from "@/lib/auth/admin-session";

// Request checks for proxy.ts (D-16), as a pure function so it is unit-tested without Next.
// 1. Host must be loopback (blocks DNS rebinding to 127.0.0.1).
// 2. State-changing requests need an Origin equal to the app's own origin (blocks other local ports and sites).
// 3. /api/admin/* (except signing in) needs a signed, unexpired admin cookie → else 401.
// 4. /admin pages (except /admin/login) need the cookie → else redirect to /admin/login.
// Handlers re-check the cookie fully (epoch included) because the proxy can't see sign-out revocation.

export type ProxyInput = { method: string; pathname: string; host: string | null; origin: string | null; cookie: string | null };
export type ProxyDecision =
  | { action: "next" }
  | { action: "deny"; status: 401 | 403; code: "UNAUTHENTICATED" | "BAD_REQUEST"; message: string }
  | { action: "redirect"; to: string };

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const SAFE = new Set(["GET", "HEAD"]);

export function decide(req: ProxyInput, sessionKey: Buffer | null, now: number): ProxyDecision {
  if (!req.host || !LOOPBACK_HOST.test(req.host)) return { action: "deny", status: 403, code: "BAD_REQUEST", message: "Forbidden host." };
  if (!SAFE.has(req.method) && req.origin !== `http://${req.host}`) return { action: "deny", status: 403, code: "BAD_REQUEST", message: "Cross-origin request refused." };
  const authed = sessionKey !== null && verifySession(req.cookie, sessionKey, now, null) !== null;
  if (req.pathname.startsWith("/api/admin/")) {
    const signingIn = req.pathname === "/api/admin/session" && req.method === "POST";
    // Without configured secrets, let the handler answer 503 (it names the missing variable in the log).
    if (!signingIn && sessionKey !== null && !authed) return { action: "deny", status: 401, code: "UNAUTHENTICATED", message: "Please sign in." };
    return { action: "next" };
  }
  if ((req.pathname === "/admin" || req.pathname.startsWith("/admin/")) && req.pathname !== "/admin/login" && !authed) return { action: "redirect", to: "/admin/login" };
  return { action: "next" };
}
