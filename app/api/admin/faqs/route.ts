import { defaultDeps } from "@/lib/api/deps";
import { faqHandlers } from "@/lib/api/admin-workspace";

let h: ReturnType<typeof faqHandlers> | null = null;
const handlers = () => (h ??= faqHandlers(defaultDeps()));

export const dynamic = "force-dynamic";
export const GET = (req: Request) => handlers().GET(req);
export const POST = (req: Request) => handlers().POST(req);
