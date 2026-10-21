import type { Metadata } from "next";
import { connection } from "next/server";
import { MenuPage } from "@/components/admin/MenuPage";

export const metadata: Metadata = { title: "Menu · Neem & Ember" };

export default async function Page() {
  await connection();
  return <MenuPage />;
}
