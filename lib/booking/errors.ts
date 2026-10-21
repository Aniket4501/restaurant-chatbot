import type { Slot } from "@/lib/booking/availability";

// API error codes (§5.9) and the typed 409 bodies (D-14).
export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "SLOT_TAKEN"
  | "SLOT_UNAVAILABLE"
  | "DUPLICATE_BOOKING"
  | "IDEMPOTENCY_MISMATCH"
  | "UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  /** D-21: an eval run is already going (admin evals dashboard). */
  | "BUSY"
  /** D-24: an unexpected server error after which the outcome is unknown (the client retries with the same key). */
  | "INTERNAL";

export type UnavailableReason = "lead_time" | "closed" | "past_horizon" | "off_grid" | "party_size" | "branch_inactive";

export type ExistingBooking = { ref: string; branch: string; startsAt: number; label: string; dateLabel: string };

export type BookingError =
  | { code: "VALIDATION"; status: 400; message: string; fields: Record<string, string> }
  | { code: "SLOT_TAKEN"; status: 409; message: string; alternatives: Slot[] }
  | { code: "SLOT_UNAVAILABLE"; status: 409; message: string; reason: UnavailableReason; alternatives: Slot[] }
  | { code: "DUPLICATE_BOOKING"; status: 409; message: string; existing: ExistingBooking | null }
  | { code: "IDEMPOTENCY_MISMATCH"; status: 422; message: string }
  | { code: "UNAVAILABLE"; status: 503; message: string }
  | { code: "NOT_FOUND"; status: 404; message: string };

export const MESSAGES = {
  SLOT_TAKEN: "Sorry, that time was just taken. Here are other times that are free.",
  SLOT_UNAVAILABLE: "That time can't be booked. Here are times that are open.",
  DUPLICATE_BOOKING: "This mobile already has a booking around this time.",
  IDEMPOTENCY_MISMATCH: "This request doesn't match the earlier one with the same key. Please start again.",
  UNAVAILABLE: "We couldn't save your booking just now, so nothing was booked. Please try again.",
  NOT_FOUND: "Booking not found.",
} as const;
