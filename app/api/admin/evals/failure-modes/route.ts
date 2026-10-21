import { bind } from "@/lib/api/deps";
import { failureModesHandler } from "@/lib/api/evals";

export const dynamic = "force-dynamic";
export const GET = bind(failureModesHandler);
