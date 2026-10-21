import { bind } from "@/lib/api/deps";
import { branchItemHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const PATCH = bind(branchItemHandler);
