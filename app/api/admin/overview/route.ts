import { bind } from "@/lib/api/deps";
import { overviewHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const GET = bind(overviewHandler);
