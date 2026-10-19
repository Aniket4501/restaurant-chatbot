import { z } from "zod";
import { getAvailability } from "@/lib/booking/availability";
import { loadAvailabilityData } from "@/lib/booking/load";
import { errorResponse, okResponse } from "@/lib/http/json";
import { isLocalDate, isLocalTime } from "@/lib/time/tz";
import type { ApiDeps } from "@/lib/api/deps";
import { slotJson } from "@/lib/api/serialize";

const Query = z.object({
  branch: z.string().min(1).max(64),
  date: z.string().refine(isLocalDate, "YYYY-MM-DD"),
  party: z.coerce.number().int(),
  time: z.string().refine(isLocalTime, "HH:MM").optional(),
  window: z.enum(["lunch", "dinner"]).optional(),
});

const ENGINE_FIELD: Record<string, [string, string]> = {
  unknown_branch: ["branch", "Unknown branch"],
  branch_inactive: ["branch", "This branch isn't taking bookings"],
  party_size: ["party", "Choose 1 to 8 guests"],
  party_too_large: ["party", "For 9 or more guests, please call the branch"],
  invalid_date: ["date", "Invalid date"],
  past_date: ["date", "That date has passed"],
  past_horizon: ["date", "Bookings open up to 30 days ahead"],
};

/** GET /api/availability?branch&date&party&time?&window? → { slots, alternatives, reason, matchedWindow } (§5.9). */
export function availabilityHandler(deps: ApiDeps) {
  return async (req: Request): Promise<Response> => {
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const q = Query.safeParse(params);
    if (!q.success) {
      const fields: Record<string, string> = {};
      for (const i of q.error.issues) fields[String(i.path[0])] ??= i.message;
      return errorResponse(400, "VALIDATION", "Please check the request.", { fields });
    }
    const { branch, date, party, time, window } = q.data;
    const r = getAvailability({ branch, date, partySize: party, time: time ?? null, window: window ?? null }, loadAvailabilityData(deps.db(), [date]), deps.now());
    if (!r.ok) {
      const [field, message] = ENGINE_FIELD[r.error];
      return errorResponse(400, "VALIDATION", message, { fields: { [field]: message }, reason: r.error });
    }
    return okResponse(200, {
      branch: r.branch,
      date: r.date,
      partySize: r.partySize,
      sittingMinutes: r.sittingMinutes,
      reason: r.reason,
      matchedWindow: r.matchedWindow,
      slots: r.slots.map((s) => slotJson(s)),
      alternatives: r.alternatives.map((s) => slotJson(s)),
    });
  };
}
