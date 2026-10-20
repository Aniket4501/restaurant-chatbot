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

/** Menu sections, as in the seed (D-20). */
export const COURSES = ["small-plates", "tandoor", "mains", "breads-rice", "desserts", "drinks"] as const;
export type Course = (typeof COURSES)[number];
/** Verified dietary tags a guest can ask for, and the allergens the menu labels (contains-*). */
export const DIETS = ["vegetarian", "vegan", "gluten-free", "jain"] as const;
export const AVOIDS = ["dairy", "nuts", "egg"] as const;
/** Allergens the menu labels don't cover (D-20 review): a guest who states one is sent to staff, never recommended a dish. */
export const UNLISTED = ["shellfish", "fish", "seafood", "soy", "sesame", "mustard", "mushroom", "coconut", "other"] as const;

export const ActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set_field"), field: z.enum(FIELDS), value: z.union([z.string().max(64), z.number().int().min(0).max(999), z.null()]) }),
  z.strictObject({ type: z.literal("select_slot"), branch: slug, startsAt: z.number().int() }),
  /** Browse the menu: no section gives the list of sections (D-20). No model call. */
  z.strictObject({ type: z.literal("menu"), course: z.enum(COURSES).nullable() }),
]);

/**
 * The guest's active food preferences, carried between turns (D-20). The model proposes them each turn; code adds
 * any it can read for certain in the guest's own words and validates every recommendation against them.
 */
export const PrefsSchema = z.strictObject({
  diet: z.array(z.enum(DIETS)).max(4),
  avoid: z.array(z.enum(AVOIDS)).max(3),
  maxPrice: z.number().int().min(1).max(100_000).nullable(),
  course: z.enum(COURSES).nullable(),
  mild: z.boolean(),
  allergy: z.boolean(),
  unlisted: z.array(z.enum(UNLISTED)).max(UNLISTED.length).default([]),
});
export type Prefs = z.infer<typeof PrefsSchema>;
export const noPrefs = (): Prefs => ({ diet: [], avoid: [], maxPrice: null, course: null, mild: false, allergy: false, unlisted: [] });

/** Bounded conversation memory the client sends back (D-13, D-20). Item IDs are re-checked against the menu. */
export const ContextSchema = z.strictObject({
  lastCitedIds: z.array(z.string().max(100)).max(8),
  prefs: PrefsSchema.nullable().optional(),
  /** Dishes suggested so far in this conversation, most recent first ("another", "cheaper"). */
  recommended: z.array(z.string().max(100)).max(6).optional(),
});
export type TurnContext = z.infer<typeof ContextSchema>;
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
    context: ContextSchema.optional(),
    /** One id per guest action; a repeat of the same id gets the same reply, with no second model call (D-20). */
    requestId: z.uuid().optional(),
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
  /** Dishes from the menu table (D-20): `lead` means items[0] is the suggestion and the rest are alternatives. */
  | { type: "recommendation"; lead: boolean; items: MenuItemView[] }
  /** A menu section, or dishes matching the guest's preferences, grouped by course (D-20). */
  | { type: "menu_list"; groups: { course: Course; label: string; items: MenuItemView[] }[] }
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

/** A dish as the guest sees it, built only from the menu table (never from model text). */
export type MenuItemView = {
  id: string;
  name: string;
  course: Course;
  courseLabel: string;
  price: number;
  description: string;
  /** Verified labels: "Vegan", "Vegetarian", "Gluten-free", "Jain option". */
  labels: string[];
  /** Labelled allergens: "dairy", "nuts", "egg". */
  contains: string[];
  /** 0 not spicy … 3 hot; null when the menu doesn't say (never shown as "not spicy"). */
  spice: number | null;
  /** "Golf Course Road only", or null when served at every branch. */
  scope: string | null;
};

export type Outcome =
  | "faq_answer"
  | "recommend"
  | "menu"
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
  /** A model value replaced by a deterministic reading of the guest's message (D-17). */
  | { action: "correct_field"; field: Field; reason: "weekday" | "day_of_month" | "large_party" }
  /** Food preferences in force after this turn (D-20); `added` lists what code read from the guest's own words. */
  | { action: "prefs"; prefs: Prefs; added: string[] }
  /** The menu filtered by the preferences (D-20): how many dishes fit, and why none did. */
  | { action: "eligible"; count: number; none: string | null }
  /** One chooser call: the dish ids it proposed, and why code rejected the proposal (empty when valid). */
  | { action: "recommend"; attempt: 1 | 2; result: "ok" | string; pick: string | null; alternatives: string[]; rejected: string[] }
  | { action: "menu"; course: Course | null; items: number }
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
  context: TurnContext;
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
