import { defaultDeps } from "@/lib/api/deps";
import { documentHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof documentHandlers> | null = null;
const handlers = () => (h ??= documentHandlers(defaultDeps()));
type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";
export const GET = (req: Request, ctx: Ctx) => handlers().GET(req, ctx);
export const PATCH = (req: Request, ctx: Ctx) => handlers().PATCH(req, ctx);
export const DELETE = (req: Request, ctx: Ctx) => handlers().DELETE(req, ctx);
