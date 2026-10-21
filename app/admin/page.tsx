import type { Metadata } from "next";
import { connection } from "next/server";
import { OverviewPage } from "@/components/admin/OverviewPage";
import { getNow } from "@/lib/time/now";

export const metadata: Metadata = { title: "Overview · Neem & Ember" };

// D-25: the staff landing page. Data loads client-side from /api/admin/overview.
export default async function AdminPage() {
  await connection();
  return <OverviewPage serverNow={getNow()} />;
}
