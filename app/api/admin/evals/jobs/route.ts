import { defaultDeps } from "@/lib/api/deps";
import { evalsJobHandlers } from "@/lib/api/evals";

// Bound on first request (never at import: `next build` imports routes).
let h: ReturnType<typeof evalsJobHandlers> | null = null;
const handlers = () => (h ??= evalsJobHandlers(defaultDeps()));

export const dynamic = "force-dynamic";
export const GET = () => handlers().GET();
export const POST = (req: Request) => handlers().POST(req);
export const DELETE = () => handlers().DELETE();
