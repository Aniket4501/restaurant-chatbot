import { bind } from "@/lib/api/deps";
import { chatTestHandler } from "@/lib/api/admin-workspace";

export const dynamic = "force-dynamic";
export const POST = bind(chatTestHandler);
