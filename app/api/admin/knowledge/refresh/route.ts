import { bind } from "@/lib/api/deps";
import { refreshHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const POST = bind(refreshHandler);
