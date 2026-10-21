import { defaultDeps } from "@/lib/api/deps";
import { menuHandlers } from "@/lib/api/admin-workspace";

// Bound on first request (never at import: `next build` imports routes).
let h: ReturnType<typeof menuHandlers> | null = null;
const handlers = () => (h ??= menuHandlers(defaultDeps()));

export const dynamic = "force-dynamic";
export const GET = (req: Request) => handlers().GET(req);
export const POST = (req: Request) => handlers().POST(req);
