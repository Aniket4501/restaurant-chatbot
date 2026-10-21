import type { Metadata } from "next";
import { connection } from "next/server";
import { FaqsPage } from "@/components/admin/FaqsPage";

export const metadata: Metadata = { title: "FAQs · Neem & Ember" };

export default async function Page({ searchParams }: PageProps<"/admin/faqs">) {
  await connection();
  const open = (await searchParams).open;
  return <FaqsPage initialOpen={typeof open === "string" ? open : null} />;
}
