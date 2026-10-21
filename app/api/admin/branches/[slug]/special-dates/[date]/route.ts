import { defaultDeps } from "@/lib/api/deps";
import { specialDateHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof specialDateHandlers> | null = null;
const handlers = () => (h ??= specialDateHandlers(defaultDeps()));
type Ctx = { params: Promise<{ slug: string; date: string }> };

export const dynamic = "force-dynamic";
export const PUT = (req: Request, ctx: Ctx) => handlers().PUT(req, ctx);
export const DELETE = (req: Request, ctx: Ctx) => handlers().DELETE(req, ctx);
