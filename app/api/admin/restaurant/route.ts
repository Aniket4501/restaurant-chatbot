import { bind } from "@/lib/api/deps";
import { restaurantHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const PATCH = bind(restaurantHandler);
