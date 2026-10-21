import type { Metadata } from "next";
import { connection } from "next/server";
import { EvalsDashboard } from "@/components/admin/evals/EvalsDashboard";
import { evalsOverview } from "@/lib/api/evals";
import { getNow } from "@/lib/time/now";

export const metadata: Metadata = { title: "Evals · Neem & Ember" };

// D-21: the evals dashboard; the data comes from evals/results. No sign-in (D-22), like the bookings page.
export default async function EvalsPage() {
  await connection();
  return (
    <main>
      <EvalsDashboard initial={evalsOverview()} serverNow={getNow()} />
    </main>
  );
}
