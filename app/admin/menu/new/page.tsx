import type { Metadata } from "next";
import { connection } from "next/server";
import { MenuItemPage } from "@/components/admin/MenuItemPage";

export const metadata: Metadata = { title: "New dish · Neem & Ember" };

export default async function Page() {
  await connection();
  return <MenuItemPage slug={null} />;
}
