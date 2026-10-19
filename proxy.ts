import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE } from "@/lib/auth/admin-session";
import { decide } from "@/lib/auth/proxy-rules";
import { loadAdminSecrets } from "@/lib/config";
import { getNow } from "@/lib/time/now";

// Next 16 renamed middleware.ts to proxy.ts (Node runtime). The gate is defence in depth: every admin handler
// re-checks with requireAdmin() (D-16), and admin uses no Server Actions (proxy coverage can't reach those).
export function proxy(request: NextRequest) {
  const secrets = loadAdminSecrets();
  const d = decide(
    {
      method: request.method,
      pathname: request.nextUrl.pathname,
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      cookie: request.cookies.get(ADMIN_COOKIE)?.value ?? null,
    },
    secrets.ok ? secrets.secretKey : null,
    getNow(), // same clock as the handlers that issue cookies (honours NOW_OVERRIDE in test mode, D-12)
  );
  if (d.action === "redirect") return NextResponse.redirect(new URL(d.to, request.url));
  if (d.action === "deny") return NextResponse.json({ error: { code: d.code, message: d.message } }, { status: d.status });
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/admin", "/admin/:path*"],
};
