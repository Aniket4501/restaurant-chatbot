import { defaultDeps } from "@/lib/api/deps";
import { knowledgeHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof knowledgeHandlers> | null = null;
const handlers = () => (h ??= knowledgeHandlers(defaultDeps()));

export const dynamic = "force-dynamic";
export const GET = (req: Request) => handlers().GET(req);
export const POST = (req: Request) => handlers().POST(req);
