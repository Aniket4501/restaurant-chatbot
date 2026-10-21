import type { Metadata } from "next";
import { connection } from "next/server";
import { AvailabilityPage } from "@/components/admin/AvailabilityPage";
import { RULES } from "@/lib/config";
import { getNow } from "@/lib/time/now";
import { todayLocal } from "@/lib/time/tz";

export const metadata: Metadata = { title: "Availability · Neem & Ember" };

export default async function Page() {
  await connection();
  return <AvailabilityPage today={todayLocal(getNow(), RULES.timezone)} />;
}
