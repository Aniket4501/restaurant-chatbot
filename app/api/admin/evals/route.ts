import { bind } from "@/lib/api/deps";
import { evalsOverviewHandler } from "@/lib/api/evals";

export const dynamic = "force-dynamic";
export const GET = bind(evalsOverviewHandler);
