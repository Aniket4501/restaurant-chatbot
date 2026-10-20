import { bind } from "@/lib/api/deps";
import { evalsRunHandler } from "@/lib/api/evals";

export const dynamic = "force-dynamic";
export const GET = bind(evalsRunHandler);
