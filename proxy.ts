import { NextResponse, type NextRequest } from "next/server";
import { decide } from "@/lib/auth/proxy-rules";

// Next 16 renamed middleware.ts to proxy.ts (Node runtime). Loopback host and same-origin changes on every API and
// staff page (D-16); the staff pages have no password (D-22).
export function proxy(request: NextRequest) {
  const d = decide({ method: request.method, host: request.headers.get("host"), origin: request.headers.get("origin") });
  if (d.action === "deny") return NextResponse.json({ error: { code: d.code, message: d.message } }, { status: d.status });
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/admin", "/admin/:path*"],
};
