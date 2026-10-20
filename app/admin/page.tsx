import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AdminDashboard } from "@/components/admin/AdminDashboard";
import { adminStatus } from "@/lib/api/admin";
import { defaultDeps } from "@/lib/api/deps";
import { ADMIN_COOKIE } from "@/lib/auth/admin-session";
import { RULES } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { getNow } from "@/lib/time/now";
import { todayLocal } from "@/lib/time/tz";

export const metadata: Metadata = { title: "Bookings · Neem & Ember" };

// The full admin check runs here too (D-16), not only in proxy.ts: it also sees sign-out revocation.
export default async function AdminPage() {
  await connection();
  const s = adminStatus((await cookies()).get(ADMIN_COOKIE)?.value ?? null, defaultDeps());
  if (s.status === "unauthenticated") redirect("/admin/login");
  if (s.status === "unconfigured")
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="font-display text-2xl">Admin isn&apos;t configured</h1>
        <p className="mt-3 text-muted">Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in .env.local, then restart the app. The server log names what is missing.</p>
      </main>
    );
  const branches = getDb().prepare("SELECT slug, name FROM branches WHERE is_active = 1 ORDER BY id").all() as { slug: string; name: string }[];
  return (
    <main>
      <AdminDashboard today={todayLocal(getNow(), RULES.timezone)} branches={branches} zone={RULES.timezone} />
    </main>
  );
}
