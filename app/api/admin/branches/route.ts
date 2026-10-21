import { bind } from "@/lib/api/deps";
import { branchesHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const GET = bind(branchesHandler);
