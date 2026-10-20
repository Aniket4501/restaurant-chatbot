import { MESSAGES } from "@/lib/booking/errors";
import type { Block, SlotChip } from "@/lib/chat/types";

// What the guest sees after the ConfirmCard POSTs to /api/reservations (§5.7 "Submission bypasses runTurn", D-14).
// Shared by the UI and the eval runner so both react to a response the same way. Client-safe: no server imports.
// The confirmation block is built only from a 201/200 response body (BR-12, INV-01).

export type SubmitBranch = { slug: string; name: string; short: string; phoneLabel: string };
export type SlotWire = { branch: string; date: string; time: string; service: "lunch" | "dinner"; startsAt: string; startsAtMs: number; label: string; dateLabel: string };
type ReservationWire = {
  ref: string;
  status: "confirmed" | "cancelled";
  branch: { slug: string; name: string; address: string; phone: string; phoneLabel?: string };
  dateLabel: string;
  timeLabel: string;
  partySize: number;
  guestName: string;
};
type ErrorWire = { error?: { code?: string; message?: string; fields?: Record<string, string>; alternatives?: SlotWire[]; existing?: { ref?: string; label: string; dateLabel: string } | null } };

export type SubmitOutcome = {
  text: string;
  blocks: Block[];
  /** The saved reference, only for a confirmed 201/200. */
  ref: string | null;
  /** Clear the draft (a booking was made). */
  clearDraft: boolean;
  /** Forget the pending { key, body }: on any 2xx or 4xx, and on 503 (nothing was committed). */
  clearPending: boolean;
  /** The outcome is unknown (network error or other 5xx): lock the card and offer Retry with the same key (D-14). */
  unknown: boolean;
  /** Field errors to show on the form (400). */
  fields: Record<string, string> | null;
};

const call = (b: SubmitBranch) => `${b.short} on ${b.phoneLabel}`;

function altChips(alts: SlotWire[], branches: SubmitBranch[], card: { branch: string; date: string }): SlotChip[] {
  return alts.map((s) => {
    const b = branches.find((x) => x.slug === s.branch);
    const parts = [s.branch !== card.branch ? (b?.short ?? s.branch) : null, s.date !== card.date ? s.dateLabel : null, s.label].filter(Boolean);
    return { ...s, label: parts.join(" · "), branchName: b?.name ?? s.branch, action: { type: "select_slot", branch: s.branch, startsAt: s.startsAtMs } };
  });
}

export function submitOutcome(
  res: { status: number; body: unknown } | { networkError: true },
  ctx: { branch: SubmitBranch; branches: SubmitBranch[]; date: string; partySize: number },
): SubmitOutcome {
  const base = { blocks: [] as Block[], ref: null, clearDraft: false, clearPending: true, unknown: false, fields: null };
  if ("networkError" in res) return { ...base, text: "We couldn't reach the restaurant to confirm your booking. Tap Retry to check whether it went through.", clearPending: false, unknown: true };
  const { status, body } = res;
  if (status === 201 || status === 200) {
    const r = (body as { reservation?: ReservationWire })?.reservation;
    if (!r) return { ...base, text: "We couldn't confirm whether your booking went through. Tap Retry to check.", clearPending: false, unknown: true };
    if (r.status === "cancelled") return { ...base, text: `This booking was cancelled; please call ${call(ctx.branch)}.` };
    const confirmation: Block = {
      type: "confirmation",
      ref: r.ref,
      status: r.status,
      branchName: r.branch.name,
      address: r.branch.address,
      phone: r.branch.phoneLabel ?? r.branch.phone,
      dateLabel: r.dateLabel,
      timeLabel: r.timeLabel,
      partySize: r.partySize,
      guestName: r.guestName,
    };
    // No text outside the card: the booked wording lives inside it, the only place claim text may appear (D-12 INV-04).
    return { ...base, text: "", blocks: [confirmation], ref: r.ref, clearDraft: true };
  }
  const err = (body as ErrorWire)?.error ?? {};
  const slots = (alts: SlotWire[] | undefined): Block[] =>
    alts?.length
      ? [{ type: "slots", heading: "Other options", branch: ctx.branch.slug, date: ctx.date, partySize: ctx.partySize, reason: "time_unavailable", groups: [], alternatives: altChips(alts, ctx.branches, { branch: ctx.branch.slug, date: ctx.date }) }]
      : [];
  // With no alternatives, never promise times (review TP-4): point to another date and the branch phone instead.
  const noTimes = `There are no other open times nearby. Please choose another date, or call ${call(ctx.branch)}.`;
  switch (err.code) {
    case "SLOT_TAKEN":
      return err.alternatives?.length ? { ...base, text: MESSAGES.SLOT_TAKEN, blocks: slots(err.alternatives) } : { ...base, text: `Sorry, that time was just taken. ${noTimes}` };
    case "SLOT_UNAVAILABLE":
      return err.alternatives?.length ? { ...base, text: MESSAGES.SLOT_UNAVAILABLE, blocks: slots(err.alternatives) } : { ...base, text: `That time can't be booked. ${noTimes}` };
    case "DUPLICATE_BOOKING": {
      const e = err.existing;
      // J7 (D-14): the existing time and ref are in the body only when the submitted name matched.
      const text = e?.ref ? `You already have a table at ${e.label} on ${e.dateLabel} (ref ${e.ref}).` : `This mobile already has a booking around this time. Please call ${call(ctx.branch)}.`;
      return { ...base, text };
    }
    case "VALIDATION":
      return { ...base, text: "Please check the highlighted details.", fields: err.fields ?? {} };
    case "IDEMPOTENCY_MISMATCH":
      return { ...base, text: MESSAGES.IDEMPOTENCY_MISMATCH };
    case "RATE_LIMITED":
      return { ...base, text: err.message ?? "Too many booking attempts. Please wait a moment." };
    case "UNAVAILABLE":
      return { ...base, text: MESSAGES.UNAVAILABLE }; // 503: nothing was committed
  }
  if (status >= 500) return { ...base, text: "We couldn't confirm whether your booking went through. Tap Retry to check.", clearPending: false, unknown: true };
  return { ...base, text: err.message ?? "Something went wrong, and nothing was booked." };
}

/**
 * The history line for an assistant reply. A confirmation card becomes "Booking confirmed (reference …): date, time,
 * party." so the model can tell a confirmed booking from one still being arranged (prompt v4 rule 1); the success
 * text itself is empty because booked wording may appear only inside the card (INV-04). No guest name or phone.
 * Used by the chat client and the eval runner, so both send the same history.
 */
export function historyContent(text: string, blocks: Block[] | undefined): string {
  const c = blocks?.find((b) => b.type === "confirmation");
  if (c && c.type === "confirmation" && c.status === "confirmed") return `Booking confirmed (reference ${c.ref}): ${c.dateLabel}, ${c.timeLabel}, ${c.partySize} ${c.partySize === 1 ? "guest" : "guests"}.`;
  return text;
}

