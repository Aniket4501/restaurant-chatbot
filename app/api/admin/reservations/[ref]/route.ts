import { bind } from "@/lib/api/deps";
import { adminCancelHandler } from "@/lib/api/admin";

export const dynamic = "force-dynamic";
export const PATCH = bind(adminCancelHandler);
