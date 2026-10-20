import { bind } from "@/lib/api/deps";
import { chatHandler } from "@/lib/api/chat";

export const dynamic = "force-dynamic";
export const POST = bind(chatHandler);
