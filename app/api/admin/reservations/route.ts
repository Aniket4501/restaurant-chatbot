import { bind } from "@/lib/api/deps";
import { adminListHandler } from "@/lib/api/admin";

export const dynamic = "force-dynamic";
export const GET = bind(adminListHandler);
