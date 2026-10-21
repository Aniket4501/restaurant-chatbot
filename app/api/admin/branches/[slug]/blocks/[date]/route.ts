import { defaultDeps } from "@/lib/api/deps";
import { blockHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof blockHandlers> | null = null;
const handlers = () => (h ??= blockHandlers(defaultDeps()));
type Ctx = { params: Promise<{ slug: string; date: string }> };

export const dynamic = "force-dynamic";
export const POST = (req: Request, ctx: Ctx) => handlers().POST(req, ctx);
export const DELETE = (req: Request, ctx: Ctx) => handlers().DELETE(req, ctx);
