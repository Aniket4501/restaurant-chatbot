import { bind } from "@/lib/api/deps";
import { reservationsHandler } from "@/lib/api/reservations";

export const dynamic = "force-dynamic";
export const POST = bind(reservationsHandler);
