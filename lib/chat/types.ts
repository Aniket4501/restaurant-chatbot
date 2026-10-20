import { z } from "zod";
import { RULES } from "@/lib/config";
import type { Intent } from "@/lib/llm/schema";
import { isLocalDate, isLocalTime } from "@/lib/time/tz";

// The /api/chat contract (§5.7, §5.9, D-13, D-15). The server is stateless: the client sends back the draft and
// context it was given, and every field is re-validated strictly, so a forged draft can only describe a booking
// request, never create one (bookings go through POST /api/reservations, which re-checks everything).

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);

export const DraftSchema = z.strictObject({
  branch: slug.nullable(),
  date: z.string().refine(isLocalDate, "YYYY-MM-DD").nullable(),
  time: z.string().refine(isLocalTime, "HH:MM").nullable(),
  timeWindow: z.enum(["lunch", "dinner"]).nullable(),
  partySize: z.number().int().min(RULES.onlinePartyMin).max(RULES.onlinePartyMax).nullable(),
  /** The slot behind a shown confirm card (D-15 pending-confirm rule). */
  selected: z.strictObject({ startsAt: z.number().int() }).nullable(),
});
export type Draft = z.infer<typeof DraftSchema>;
export const emptyDraft = (): Draft => ({ branch: null, date: null, time: null, timeWindow: null, partySize: null, selected: null });

export const FIELDS = ["branch", "date", "time", "timeWindow", "partySize"] as const;
export type Field = (typeof FIELDS)[number];

export const ActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set_field"), field: z.enum(FIELDS), value: z.union([z.string().max(64), z.number().int().min(0).max(999), z.null()]) }),
  z.strictObject({ type: z.literal("select_slot"), branch: slug, startsAt: z.number().int() }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const MessageSchema = z.strictObject({ role: z.enum(["guest", "assistant"]), content: z.string() });
export type ChatMessage = z.infer<typeof MessageSchema>;

/** POST /api/chat body (D-15 caps). Sizes over 16 KB are refused with 413 before parsing (readJson). */
export const ChatBodySchema = z
  .strictObject({
    sessionId: z.uuid(),
    messages: z.array(MessageSchema).max(8),
    draft: DraftSchema.nullable(),
    action: ActionSchema.optional(),
    context: z.strictObject({ lastCitedIds: z.array(z.string().max(100)).max(8) }).optional(),
  })
  .superRefine((b, ctx) => {
    b.messages.forEach((m, i) => {
      const max = m.role === "guest" ? 500 : 600;
      if (m.content.length > max) ctx.addIssue({ code: "custom", path: ["messages", i, "content"], message: `at most ${max} characters` });
    });
    if (!b.action) {
      const last = b.messages.at(-1);
      if (!last || last.role !== "guest" || !last.content.trim()) ctx.addIssue({ code: "custom", path: ["messages"], message: "the last message must be the guest's (or send an action)" });
    }
  });
export type ChatBody = z.infer<typeof ChatBodySchema>;

/** A chip either performs an action (no model call) or sends text as the guest's next message. */
export type Chip = { label: string; action: Action } | { label: string; text: string };

export type SlotChip = {
  label: string;
  branch: string;
  branchName: string;
  date: string;
  dateLabel: string;
  time: string;
  service: "lunch" | "dinner";
  startsAt: string; // ISO with the branch offset
  startsAtMs: number;
  action: Action;
};

export type Block =
  | { type: "quick_replies"; chips: Chip[] }
  | { type: "field_request"; field: Field; prompt: string; chips: Chip[] }
  | {
      type: "slots";
      heading: string; // "Sat 24 Oct · Hauz Khas · 4 guests" (§5.10)
      branch: string;
      date: string;
      partySize: number;
      reason: null | "closed" | "no_more_today" | "fully_booked" | "time_unavailable";
      groups: { service: "lunch" | "dinner"; slots: SlotChip[] }[];
      alternatives: SlotChip[];
    }
  | {
      type: "confirm";
      branch: string;
      branchName: string;
      address: string;
      phone: string;
      date: string;
      dateLabel: string;
      time: string;
      timeLabel: string;
      startsAt: string;
      startsAtMs: number;
      partySize: number;
      sittingMinutes: number;
    }
  | { type: "info"; factIds: string[]; items: { id: string; text: string }[] }
  | { type: "notice"; tone: "info" | "warning"; text: string }
  /** Added by the client, and only from a 201/200 reservation response (BR-12, §5.7). Never sent by /api/chat. */
  | {
      type: "confirmation";
      ref: string;
      status: "confirmed" | "cancelled";
      branchName: string;
      address: string;
      phone: string;
      dateLabel: string;
      timeLabel: string;
      partySize: number;
      guestName: string;
    };

export type Outcome =
  | "faq_answer"
  | "hours_answer"
  | "faq_fallback"
  | "ask_field"
  | "slots"
  | "confirm"
  | "redirect"
  | "manage_redirect"
  | "smalltalk"
  | "clarify"
  | "degraded"
  | "rate_limited"
  | "action";

/** Backend actions in order (§5.7 `trace`); the eval runner asserts on these. Never contains guest text. */
export type TraceEntry =
  | { action: "retrieve"; mode: "hybrid" | "lexical"; reason: string | null; ids: string[] }
  | { action: "model_call"; attempt: 1 | 2; result: "ok" | string }
  | { action: "check_availability"; args: { branch: string; date: string; partySize: number; time: string | null; window: string | null }; result: string; slots: number; alternatives: number }
  | { action: "ask_field"; field: Field; reason?: string }
  /** A model value the guest's latest message doesn't state, dropped before the merge (§5.7). */
  | { action: "ignore_field"; field: Field; reason: "not_stated" }
  | { action: "confirm"; branch: string; startsAt: number }
  | { action: "answer_faq"; ids: string[]; rendered: boolean }
  | { action: "fallback_unknown"; reason: string }
  | { action: "redirect"; kind: "off_topic" | "manage_booking" | "large_party" }
  | { action: "smalltalk"; shown: boolean }
  | { action: "clarify" }
  | { action: "pending_confirm" }
  | { action: "degraded"; code: string }
  | { action: "rate_limited" }
  | { action: "metrics_write_failed" }
  | { action: "availability_error" }
  /** Recorded by the eval runner for {submit} turns (§5.7). */
  | { action: "create_reservation"; result: { status: number; code: string | null; ref: string | null } };

export type TurnReply = {
  status: "ok" | "rate_limited";
  retryAfterMs?: number;
  reply: { text: string; blocks: Block[] };
  draft: Draft;
  intent: Intent | null;
  context: { lastCitedIds: string[] };
  trace: TraceEntry[];
  meta: {
    outcome: Outcome;
    degraded: boolean;
    retrievalMode: "hybrid" | "lexical" | "none";
    retrievalReason: string | null;
    citedFactIds: string[];
    model: string;
    promptVersion: string | null;
    latencyMs: number;
    modelMs: number | null;
    retrievalMs: number | null;
    promptTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
  };
};
