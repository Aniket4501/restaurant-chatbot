import { bind } from "@/lib/api/deps";
import { branchAvailabilityHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const GET = bind(branchAvailabilityHandler);
