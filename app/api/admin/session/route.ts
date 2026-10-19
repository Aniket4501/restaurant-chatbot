import { bind } from "@/lib/api/deps";
import { adminSessionHandlers } from "@/lib/api/admin";

export const dynamic = "force-dynamic";
export const POST = bind((d) => adminSessionHandlers(d).POST);
export const DELETE = bind((d) => adminSessionHandlers(d).DELETE);
