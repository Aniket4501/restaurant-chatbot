import { defaultDeps } from "@/lib/api/deps";
import { menuItemHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof menuItemHandlers> | null = null;
const handlers = () => (h ??= menuItemHandlers(defaultDeps()));

export const dynamic = "force-dynamic";
export const GET = (req: Request, ctx: { params: Promise<{ slug: string }> }) => handlers().GET(req, ctx);
export const PATCH = (req: Request, ctx: { params: Promise<{ slug: string }> }) => handlers().PATCH(req, ctx);
