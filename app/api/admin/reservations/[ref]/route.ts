import { defaultDeps } from "@/lib/api/deps";
import { bookingItemHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof bookingItemHandlers> | null = null;
const handlers = () => (h ??= bookingItemHandlers(defaultDeps()));
type Ctx = { params: Promise<{ ref: string }> };

export const dynamic = "force-dynamic";
export const GET = (req: Request, ctx: Ctx) => handlers().GET(req, ctx);
export const PATCH = (req: Request, ctx: Ctx) => handlers().PATCH(req, ctx);
