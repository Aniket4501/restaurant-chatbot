import { defaultDeps } from "@/lib/api/deps";
import { tableItemHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof tableItemHandlers> | null = null;
const handlers = () => (h ??= tableItemHandlers(defaultDeps()));

export const dynamic = "force-dynamic";
export const PATCH = (req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) => handlers().PATCH(req, ctx);
