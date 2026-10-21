import type { Metadata } from "next";
import { connection } from "next/server";
import { KnowledgePage } from "@/components/admin/KnowledgePage";

export const metadata: Metadata = { title: "Knowledge base · Neem & Ember" };

export default async function Page() {
  await connection();
  return <KnowledgePage />;
}
