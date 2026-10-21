import type { ApiDeps } from "@/lib/api/deps";
import { bookingItemHandlers, bookingsListHandler } from "@/lib/api/admin-workspace";

// The staff bookings endpoints (§5.9, AC-07, BR-13), now served by the D-25 workspace handlers:
// GET /api/admin/reservations?date&branch&status&q: the day's bookings by time (or a name/reference search across all
//   dates), with a masked mobile number; totals cover the day and branch: confirmed bookings, their guests, cancellations.
// PATCH /api/admin/reservations/:ref {status:'cancelled'}: idempotent staff cancel.
export const adminListHandler = (deps: ApiDeps) => bookingsListHandler(deps);
export const adminCancelHandler = (deps: ApiDeps) => bookingItemHandlers(deps).PATCH;
