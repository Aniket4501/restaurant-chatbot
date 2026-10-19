import { bind } from "@/lib/api/deps";
import { healthHandler } from "@/lib/api/health";

export const dynamic = "force-dynamic";
export const GET = bind(healthHandler);
