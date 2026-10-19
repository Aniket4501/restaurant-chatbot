import { bind } from "@/lib/api/deps";
import { availabilityHandler } from "@/lib/api/availability";

export const dynamic = "force-dynamic";
export const GET = bind(availabilityHandler);
