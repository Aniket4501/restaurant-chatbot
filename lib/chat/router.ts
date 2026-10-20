import { RULES } from "@/lib/config";
import { checkStart, getAvailability, type AvailabilityBundle, type Slot } from "@/lib/booking/availability";
import type { Fact } from "@/lib/kb/facts";
import type { Turn } from "@/lib/llm/schema";
import { addLocalDays, dayLabel, dayLabelLong, isoInZone, localDateOf, localTimeOf, timeLabel, timeLabelOf, todayLocal, type LocalDate } from "@/lib/time/tz";
import { smalltalkShowable } from "@/lib/chat/claims";
import { applySetField, bookingInProgress, mergeExtracted, type FieldCtx, type FieldIssue, type MergeResult } from "@/lib/chat/draft";
import { checkGrounding, type GroundingContext } from "@/lib/chat/grounding";
import { isHoursOnly, renderHoursAnswer } from "@/lib/chat/hours";
import { T, type BranchInfo } from "@/lib/chat/templates";
import type { Action, Block, Chip, Draft, Field, Outcome, SlotChip, TraceEntry } from "@/lib/chat/types";

// Deterministic turn logic (§5.7 step 2 and 5): the booking flow driven by the draft, and routing of a validated
// model turn by intent. Booking turns only ever show templates; model prose appears only for FAQ answers that pass
// grounding and smalltalk that passes the claim rules (D-10, D-11, D-15).

export type FlowCtx = FieldCtx & {
  bundle: (dates: LocalDate[]) => AvailabilityBundle;
  trace: TraceEntry[];
};

export type Step = { text: string; blocks: Block[]; draft: Draft; outcome: Outcome; citedFactIds?: string[] };

const shortOf = (ctx: FieldCtx, slug: string) => ctx.branches.find((b) => b.slug === slug)?.short ?? slug;
const guests = (n: number) => `${n} ${n === 1 ? "guest" : "guests"}`;

/** Branches a phone template should name: the draft's branch if known, else every active branch (D-15). */
export function phoneBranches(ctx: FieldCtx, ...candidates: (string | null | undefined)[]): BranchInfo[] {
  for (const slug of candidates) {
    const b = slug ? ctx.branches.find((x) => x.slug === slug) : undefined;
    if (b) return [b];
  }
  return ctx.branches;
}

// ---------- chips ----------

export function fieldChips(field: Field, ctx: FieldCtx, candidates?: string[]): Chip[] {
  const set = (value: string | number): Action => ({ type: "set_field", field, value });
  if (field === "branch") return (candidates ?? ctx.branches.map((b) => b.slug)).map((s) => ({ label: shortOf(ctx, s), action: set(s) }));
  if (field === "date") {
    const today = todayLocal(ctx.now, ctx.zone);
    const dates = candidates ?? Array.from({ length: 7 }, (_, i) => addLocalDays(today, i, ctx.zone));
    return dates.map((d) => {
      const rel = d === today ? "Today, " : d === addLocalDays(today, 1, ctx.zone) ? "Tomorrow, " : "";
      return { label: `${rel}${dayLabel(d, ctx.zone)}`, action: set(d) }; // absolute date on every chip (J5)
    });
  }
  if (field === "partySize") {
    if (candidates) return candidates.map((c) => ({ label: guests(Number(c)), action: set(Number(c)) }));
    return [...Array.from({ length: RULES.onlinePartyMax }, (_, i) => ({ label: guests(i + 1), action: set(i + 1) })), { label: "9 or more", action: set(RULES.onlinePartyMax + 1) }];
  }
  if (field === "time") return (candidates ?? []).map((t) => ({ label: timeLabelOf(t), action: set(t) }));
  return (candidates ?? ["lunch", "dinner"]).map((w) => ({ label: w === "lunch" ? "Lunch" : "Dinner", action: set(w) }));
}

function slotChip(s: Slot, ctx: FieldCtx, withBranch: boolean, withDate: boolean): SlotChip {
  const b = ctx.branches.find((x) => x.slug === s.branch)!;
  const zone = b.timezone;
  const parts = [withBranch ? b.short : null, withDate ? dayLabel(s.date, zone) : null, s.label].filter(Boolean);
  return {
    label: parts.join(" · "),
    branch: s.branch,
    branchName: b.name,
    date: s.date,
    dateLabel: dayLabel(s.date, zone),
    time: s.time,
    service: s.service,
    startsAt: isoInZone(s.startsAt, zone),
    startsAtMs: s.startsAt,
    action: { type: "select_slot", branch: s.branch, startsAt: s.startsAt },
  };
}

function confirmBlock(b: BranchInfo, startsAt: number, partySize: number): Block {
  const date = localDateOf(startsAt, b.timezone);
  return {
    type: "confirm",
    branch: b.slug,
    branchName: b.name,
    address: b.address,
    phone: b.phoneLabel,
    date,
    dateLabel: dayLabelLong(date, b.timezone),
    time: localTimeOf(startsAt, b.timezone),
    timeLabel: timeLabel(startsAt, b.timezone),
    startsAt: isoInZone(startsAt, b.timezone),
    startsAtMs: startsAt,
    partySize,
    sittingMinutes: RULES.sittingMinutes(partySize),
  };
}

// ---------- booking flow ----------

const ISSUE_TEXT: Partial<Record<FieldIssue, string>> = {
  bad_branch: T.badBranch,
  branch_inactive: T.branchInactive,
  past_date: T.pastDate,
  past_horizon: T.pastHorizon,
};
const ASK: Record<"branch" | "date" | "partySize", string> = { branch: T.askBranch, date: T.askDate, partySize: T.askPartySize };

function ask(field: "branch" | "date" | "partySize", draft: Draft, ctx: FlowCtx, prompt = ASK[field], reason?: string): Step {
  ctx.trace.push({ action: "ask_field", field, ...(reason ? { reason } : {}) });
  return { text: prompt, blocks: [{ type: "field_request", field, prompt, chips: fieldChips(field, ctx) }], draft, outcome: "ask_field" };
}

/**
 * The next booking step for a draft: ask for the first missing field (branch, date, party size), else run
 * availability. A time preference that is open right now goes straight to the confirm card (§5.7 routing table).
 */
export function nextStep(merge: Pick<MergeResult, "draft" | "issues" | "ambiguity" | "largeParty">, ctx: FlowCtx): Step {
  const draft = merge.draft;
  if (merge.ambiguity) {
    const { field, candidates } = merge.ambiguity;
    ctx.trace.push({ action: "ask_field", field, reason: "ambiguous" });
    const prompt = T.askAmbiguous(field);
    return { text: prompt, blocks: [{ type: "field_request", field, prompt, chips: fieldChips(field, ctx, candidates) }], draft, outcome: "ask_field" };
  }
  if (merge.largeParty) {
    ctx.trace.push({ action: "redirect", kind: "large_party" });
    const text = T.largeParty(phoneBranches(ctx, draft.branch));
    return { text, blocks: [{ type: "field_request", field: "partySize", prompt: T.askPartySize, chips: fieldChips("partySize", ctx).slice(0, RULES.onlinePartyMax) }], draft, outcome: "redirect" };
  }
  // A value the guest gave that we can't use is always asked about, even if the draft still has an older one.
  const issue = merge.issues.find((i) => i.field === "branch" || i.field === "date" || i.field === "partySize");
  if (issue && (issue.field === "branch" || issue.field === "date" || issue.field === "partySize")) return ask(issue.field, draft, ctx, ISSUE_TEXT[issue.issue] ?? ASK[issue.field], issue.issue);
  if (draft.branch === null) return ask("branch", draft, ctx);
  if (draft.date === null) return ask("date", draft, ctx);
  if (draft.partySize === null) return ask("partySize", draft, ctx);
  return availabilityStep(draft, ctx);
}

/** Availability couldn't be read (§6.2 #16): say so, show no times, and offer a retry chip. Never invents slots. */
function couldntCheck(draft: Draft, ctx: FlowCtx): Step {
  ctx.trace.push({ action: "availability_error" });
  const retry: Chip[] = draft.partySize !== null ? [{ label: "Try again", action: { type: "set_field", field: "partySize", value: draft.partySize } }] : [];
  return { text: T.couldntCheck, blocks: [{ type: "notice", tone: "warning", text: T.couldntCheck }, ...(retry.length ? [{ type: "quick_replies" as const, chips: retry }] : [])], draft: { ...draft, selected: null }, outcome: "slots" };
}

function loadBundle(ctx: FlowCtx, dates: LocalDate[]): AvailabilityBundle | null {
  try {
    return ctx.bundle(dates);
  } catch {
    return null;
  }
}

function availabilityStep(draft: Draft, ctx: FlowCtx, lead?: string): Step {
  const q = { branch: draft.branch!, date: draft.date!, partySize: draft.partySize!, time: draft.time, window: draft.timeWindow };
  const bundle = loadBundle(ctx, [q.date]);
  if (!bundle) return couldntCheck(draft, ctx);
  const r = getAvailability(q, bundle, ctx.now);
  const args = { branch: q.branch, date: q.date, partySize: q.partySize, time: q.time, window: q.window };
  if (!r.ok) {
    ctx.trace.push({ action: "check_availability", args, result: r.error, slots: 0, alternatives: 0 });
    if (r.error === "past_date" || r.error === "past_horizon" || r.error === "invalid_date") return ask("date", { ...draft, date: null, selected: null }, ctx, r.error === "past_horizon" ? T.pastHorizon : T.pastDate, r.error);
    if (r.error === "party_too_large") return nextStep({ draft: { ...draft, partySize: null, selected: null }, issues: [], ambiguity: null, largeParty: true }, ctx);
    if (r.error === "party_size") return ask("partySize", { ...draft, partySize: null, selected: null }, ctx);
    return ask("branch", { ...draft, branch: null, selected: null }, ctx, r.error === "branch_inactive" ? T.branchInactive : T.badBranch, r.error);
  }
  ctx.trace.push({ action: "check_availability", args, result: r.reason ?? "ok", slots: r.slots.length, alternatives: r.alternatives.length });
  const b = ctx.branches.find((x) => x.slug === q.branch)!;
  const exact = draft.time ? r.slots.find((s) => s.time === draft.time) : undefined;
  if (exact) {
    ctx.trace.push({ action: "confirm", branch: b.slug, startsAt: exact.startsAt });
    return { text: lead ? `${lead} ${T.confirmIntro}` : T.confirmIntro, blocks: [confirmBlock(b, exact.startsAt, q.partySize)], draft: { ...draft, selected: { startsAt: exact.startsAt } }, outcome: "confirm" };
  }
  const heading = `${dayLabel(q.date, b.timezone)} · ${b.short} · ${guests(q.partySize)}`;
  const dateLabelText = dayLabel(q.date, b.timezone);
  const windowMiss = !draft.time && !!draft.timeWindow && !r.matchedWindow;
  const reason = r.reason ?? (draft.time || windowMiss ? "time_unavailable" : null);
  const nothing = !r.slots.length && !r.alternatives.length;
  const first =
    r.reason === "closed"
      ? T.closed(b.short, dateLabelText)
      : r.reason === "no_more_today"
        ? T.noMoreToday(b.short)
        : r.reason === "fully_booked"
          ? T.fullyBooked(b.short, dateLabelText)
          : draft.time
            ? T.timeUnavailable(timeLabelOf(draft.time))
            : windowMiss
              ? T.windowUnavailable(draft.timeWindow!, b.short, dateLabelText)
              : T.slotsIntro(heading);
  const then = nothing ? T.askDate : r.reason || windowMiss ? T.otherOptions : draft.time ? T.nearestTimes : null;
  const text = [lead, first, then].filter(Boolean).join(" ");
  const groups = (["lunch", "dinner"] as const).map((service) => ({ service, slots: r.slots.filter((s) => s.service === service).map((s) => slotChip(s, ctx, false, false)) })).filter((g) => g.slots.length);
  const blocks: Block[] = [
    {
      type: "slots",
      heading,
      branch: q.branch,
      date: q.date,
      partySize: q.partySize,
      reason,
      groups,
      alternatives: r.alternatives.map((s) => slotChip(s, ctx, s.branch !== q.branch, s.date !== q.date)),
    },
  ];
  if (nothing) blocks.push({ type: "field_request", field: "date", prompt: T.askDate, chips: fieldChips("date", ctx) });
  return { text, blocks, draft: { ...draft, selected: null }, outcome: "slots" };
}

/** A chip or slot tap (§5.7 step 2): no model call. */
/** Booking actions: chips and slot taps (menu browsing is handled in runTurn, which has the menu). */
export function handleAction(action: Exclude<Action, { type: "menu" }>, draft: Draft, ctx: FlowCtx): Step {
  if (action.type === "set_field") return nextStep(applySetField(draft, action.field, action.value, ctx), ctx);
  if (draft.partySize === null) return ask("partySize", draft, ctx);
  const bundle = loadBundle(ctx, [localDateOf(action.startsAt, ctx.zone)]);
  if (!bundle) return couldntCheck(draft, ctx);
  const check = checkStart(bundle, action.branch, draft.partySize, action.startsAt, ctx.now);
  const b = ctx.branches.find((x) => x.slug === action.branch);
  if (!check.ok || !b) {
    ctx.trace.push({ action: "check_availability", args: { branch: action.branch, date: localDateOf(action.startsAt, ctx.zone), partySize: draft.partySize, time: null, window: null }, result: check.ok ? "unknown_branch" : check.reason, slots: 0, alternatives: 0 });
    if (!b) return ask("branch", { ...draft, branch: null, selected: null }, ctx, T.badBranch);
    const date = localDateOf(action.startsAt, b.timezone);
    return availabilityStep({ ...draft, branch: b.slug, date, time: null, selected: null }, ctx, T.slotGone);
  }
  const time = localTimeOf(action.startsAt, b.timezone);
  ctx.trace.push({ action: "confirm", branch: b.slug, startsAt: action.startsAt });
  return {
    text: T.confirmIntro,
    blocks: [confirmBlock(b, action.startsAt, draft.partySize)],
    draft: { ...draft, branch: b.slug, date: check.date, time, selected: { startsAt: action.startsAt } },
    outcome: "confirm",
  };
}

// ---------- model turns ----------

export type FactCtx = GroundingContext & { staticFacts: Fact[] };

// The same starting points as the welcome (D-20). "Find a table" asks for the branch with no model call.
const QUICK_REPLIES = (): Block => ({
  type: "quick_replies",
  chips: [
    { label: "Help me find a dish", text: "Help me find a dish" },
    { label: "Show me the menu", action: { type: "menu", course: null } as Action },
    { label: "Find a table", action: { type: "set_field", field: "branch", value: null } as Action },
    { label: "Opening hours", text: "What are your opening hours?" },
  ],
});

/** A recommend or menu turn worked out in runTurn (it needs the menu and, for recommendations, a second model call). */
export type Prepared = { text: string; blocks: Block[]; cited: string[] };

/** Route a validated model turn by intent (§5.7 step 5, D-10, D-15). */
export function routeTurn(turn: Turn, draft: Draft, ctx: FlowCtx, facts: FactCtx, prepared: Prepared | null = null): Step {
  const known = (draft.branch ?? turn.booking.branch) as string | null;
  if (turn.intent === "booking") return nextStep(mergeExtracted(draft, turn.booking, ctx), ctx); // templates only; prose dropped

  // A booking in progress is kept, and its pending question is repeated after the answer (§5.7 merge rules).
  const resumed = bookingInProgress(draft) ? nextStep({ draft, issues: [], ambiguity: null, largeParty: false }, ctx) : null;
  // D-15's pending-confirm rule is decided on the reply actually sent (review TP-2): model prose is replaced only when
  // this reply carries a confirm card, and if the guest's selected slot was lost, that step's text is shown as a notice.
  const confirmShown = !!resumed?.blocks.some((b) => b.type === "confirm");
  const lostSelection = draft.selected !== null && !confirmShown;
  const prose = (text: string) => {
    if (!confirmShown) return text;
    ctx.trace.push({ action: "pending_confirm" });
    return T.pendingConfirm;
  };
  // The lost-slot note is a template, so it goes in a notice block and never mixes with model prose (INV-05).
  const lostNote: Block[] = lostSelection && resumed ? [{ type: "notice", tone: "warning", text: resumed.text }] : [];
  const reply = (text: string, outcome: Outcome, o: { lead?: Block[]; idle?: Block[]; cited?: string[] } = {}): Step => ({
    text,
    blocks: [...(o.lead ?? []), ...lostNote, ...(resumed ? resumed.blocks : (o.idle ?? []))],
    draft: resumed?.draft ?? draft,
    outcome,
    ...(o.cited ? { citedFactIds: o.cited } : {}),
  });

  switch (turn.intent) {
    case "faq": {
      if (!turn.answerable) {
        ctx.trace.push({ action: "fallback_unknown", reason: "answerable_false" });
        return reply(T.fallback(phoneBranches(ctx, known)), "faq_fallback");
      }
      const cited = [...new Set(turn.citedFactIds)];
      const unknown = cited.length === 0 ? "no_citation" : cited.some((id) => !facts.factsById.has(id)) ? "unknown_citation" : cited.some((id) => !facts.sentIds.has(id)) ? "not_sent" : null;
      if (!unknown && isHoursOnly(cited)) {
        const r = renderHoursAnswer(cited, facts.factsById, facts.zoneOf);
        ctx.trace.push({ action: "answer_faq", ids: r.factIds, rendered: true });
        // No card repeating the cited facts under the answer (D-20: it duplicated every answer and showed internal
        // list wording); the cited IDs stay in the reply's metadata for the invariants.
        return reply(prose(r.text), "hours_answer", { cited: r.factIds });
      }
      const g = unknown ? ({ ok: false, reason: unknown, detail: "" } as const) : checkGrounding(turn.answer ?? "", cited, facts);
      if (!g.ok || !turn.answer?.trim()) {
        ctx.trace.push({ action: "fallback_unknown", reason: g.ok ? "empty_answer" : g.reason });
        return reply(T.fallback(phoneBranches(ctx, known)), "faq_fallback");
      }
      ctx.trace.push({ action: "answer_faq", ids: g.citedIds, rendered: false });
      return reply(prose(turn.answer.trim()), "faq_answer", { cited: g.citedIds });
    }
    case "recommend":
    case "menu": {
      // Worked out in runTurn (D-20); a booking in progress is kept and its pending question repeated, as for FAQs.
      const p = prepared ?? { text: T.clarify, blocks: [QUICK_REPLIES()], cited: [] };
      return reply(prose(p.text), turn.intent, { lead: p.blocks, cited: p.cited });
    }
    case "manage_booking":
      ctx.trace.push({ action: "redirect", kind: "manage_booking" });
      return reply(T.manageBooking(phoneBranches(ctx, known)), "manage_redirect");
    case "off_topic":
      ctx.trace.push({ action: "redirect", kind: "off_topic" });
      return reply(T.offTopic, "redirect", { idle: [QUICK_REPLIES()] });
    case "smalltalk": {
      if (confirmShown) return reply(prose(""), "smalltalk");
      const shown = !!turn.answer && smalltalkShowable(turn.answer);
      ctx.trace.push({ action: "smalltalk", shown });
      return reply(shown ? turn.answer!.trim() : T.greeting, "smalltalk", { idle: [QUICK_REPLIES()] });
    }
    case "unclear":
      ctx.trace.push({ action: "clarify" });
      return reply(T.clarify, "clarify", { idle: [QUICK_REPLIES()] });
  }
}

/** The degraded reply (§5.7 step 4): a short notice plus the booking flow's chips, which need no model. */
export function degradedStep(draft: Draft, ctx: FlowCtx, code: string): Step {
  ctx.trace.push({ action: "degraded", code });
  const step = bookingInProgress(draft) ? nextStep({ draft, issues: [], ambiguity: null, largeParty: false }, ctx) : null;
  const blocks: Block[] = [{ type: "notice", tone: "warning", text: T.degraded }, ...(step ? step.blocks : [{ type: "field_request" as const, field: "branch" as const, prompt: T.askBranch, chips: fieldChips("branch", ctx) }])];
  return { text: T.degraded, blocks, draft: step?.draft ?? draft, outcome: "degraded" };
}

export const quickReplies = QUICK_REPLIES;
