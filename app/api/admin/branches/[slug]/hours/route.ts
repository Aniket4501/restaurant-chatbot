import { bind } from "@/lib/api/deps";
import { weeklyHoursHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const PUT = bind(weeklyHoursHandler);
