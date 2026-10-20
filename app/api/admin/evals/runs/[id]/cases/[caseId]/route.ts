import { bind } from "@/lib/api/deps";
import { evalsCaseHandler } from "@/lib/api/evals";

export const dynamic = "force-dynamic";
export const GET = bind(evalsCaseHandler);
