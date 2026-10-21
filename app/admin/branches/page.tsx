import type { Metadata } from "next";
import { connection } from "next/server";
import { BranchesPage } from "@/components/admin/BranchesPage";

export const metadata: Metadata = { title: "Branches · Neem & Ember" };

export default async function Page() {
  await connection();
  return <BranchesPage />;
}
