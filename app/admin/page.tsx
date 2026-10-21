import type { Metadata } from "next";
import { connection } from "next/server";
import { AdminDashboard } from "@/components/admin/AdminDashboard";
import { RULES } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { getNow } from "@/lib/time/now";
import { todayLocal } from "@/lib/time/tz";

export const metadata: Metadata = { title: "Bookings · Neem & Ember" };

// The staff bookings page. No sign-in (D-22): the app is a local demo bound to 127.0.0.1.
export default async function AdminPage() {
  await connection();
  const branches = getDb().prepare("SELECT slug, name FROM branches WHERE is_active = 1 ORDER BY id").all() as { slug: string; name: string }[];
  return (
    <main>
      <AdminDashboard today={todayLocal(getNow(), RULES.timezone)} branches={branches} zone={RULES.timezone} />
    </main>
  );
}
