import { defaultDeps } from "@/lib/api/deps";
import { tableHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof tableHandlers> | null = null;
const handlers = () => (h ??= tableHandlers(defaultDeps()));

export const dynamic = "force-dynamic";
export const POST = (req: Request, ctx: { params: Promise<{ slug: string }> }) => handlers().POST(req, ctx);
