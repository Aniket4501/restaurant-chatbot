import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { EvalsDashboard } from "@/components/admin/evals/EvalsDashboard";
import { adminStatus } from "@/lib/api/admin";
import { defaultDeps } from "@/lib/api/deps";
import { evalsOverview } from "@/lib/api/evals";
import { ADMIN_COOKIE } from "@/lib/auth/admin-session";
import { getNow } from "@/lib/time/now";

export const metadata: Metadata = { title: "Evals · Neem & Ember" };

// D-21: the evals dashboard. Staff only (the same check as /admin, D-16); the data comes from evals/results.
export default async function EvalsPage() {
  await connection();
  const s = adminStatus((await cookies()).get(ADMIN_COOKIE)?.value ?? null, defaultDeps());
  if (s.status === "unauthenticated") redirect("/admin/login");
  if (s.status === "unconfigured")
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="font-display text-2xl">Admin isn&apos;t configured</h1>
        <p className="mt-3 text-muted">Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in .env.local, then restart the app.</p>
      </main>
    );
  return (
    <main>
      <EvalsDashboard initial={evalsOverview()} serverNow={getNow()} />
    </main>
  );
}
