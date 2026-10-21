import type { Metadata } from "next";
import { connection } from "next/server";
import { MenuItemPage } from "@/components/admin/MenuItemPage";

export const metadata: Metadata = { title: "Dish · Neem & Ember" };

export default async function Page({ params, searchParams }: PageProps<"/admin/menu/[slug]">) {
  await connection();
  const { slug } = await params;
  const created = (await searchParams).created === "1";
  return <MenuItemPage slug={slug} justCreated={created} />;
}
