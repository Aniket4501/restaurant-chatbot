import type { Metadata } from "next";
import { connection } from "next/server";
import { DocumentPage } from "@/components/admin/DocumentPage";

export const metadata: Metadata = { title: "Document · Neem & Ember" };

export default async function Page({ params }: PageProps<"/admin/knowledge/[id]">) {
  await connection();
  const { id } = await params;
  return <DocumentPage id={id} />;
}
