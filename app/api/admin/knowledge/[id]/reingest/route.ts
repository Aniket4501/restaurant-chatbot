import { bind } from "@/lib/api/deps";
import { documentReingestHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const POST = bind(documentReingestHandler);
