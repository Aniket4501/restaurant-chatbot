"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { historyContent, submitOutcome, type SubmitBranch } from "@/lib/chat/submit";
import type { Action, Block, TurnReply } from "@/lib/chat/types";
import { BlockView, type BlockHandlers, type BranchCard } from "@/components/chat/Blocks";
import { ConfirmCard, type CardState } from "@/components/chat/ConfirmCard";
import { clear, load, save, type CreateBody, type Item, type Pending, type Saved } from "@/components/chat/storage";
import { ArrowUpIcon, LeafMark } from "@/components/ui/icons";

// The reservations-and-questions panel (§5.7 client side, §5.10, D-14).
// - Typed messages and chip/slot taps go to POST /api/chat; the server returns the reply, blocks and new draft.
// - The confirm card POSTs to /api/reservations with an Idempotency-Key. { key, body } is stored before the POST and
//   replayed on reload. A confirmation is shown only from a 201/200 body (BR-12), via the shared submitOutcome.
// - While a submit's outcome is unknown, the card, chips and times are locked; the guest can Retry or Start over.

type Props = {
  branches: SubmitBranch[];
  restaurantName: string;
  scripted: boolean;
  /** Mobile-first redesign: the hero scrolls with the conversation; branch details for the branch cards; date bounds for the slot picker. */
  header?: ReactNode;
  branchCards?: BranchCard[];
  today?: string;
  horizonDays?: number;
  /** Called once mounted, before paint, so the wrapper can drop its server-rendered placeholder. */
  onReady?: () => void;
};
// One request id per guest action (D-20): "Try again" resends the same id, so a reply that was lost in transit comes
// back from the server's dedupe instead of a second model call.
type ChatRequest = { messages: { role: "guest" | "assistant"; content: string }[]; action?: Action; requestId: string };

const uid = () => crypto.randomUUID();

function welcome(name: string): Item {
  return {
    id: "welcome",
    role: "assistant",
    text: `Welcome to ${name}. I can help you choose a dish, show you the menu, or find you a table.`,
    blocks: [
      {
        type: "quick_replies",
        // Starting points, not limits (D-20). Menu and table need no model call: a menu action lists the sections,
        // and an empty set_field asks for the first missing booking field, the branch (§5.7 step 2). The food chips
        // are actions too (D-24): no intent call for a chip whose meaning is fixed.
        chips: [
          { label: "Help me find a dish", action: { type: "recommend", text: "Help me find a dish" } },
          { label: "Show me the menu", action: { type: "menu", course: null } },
          { label: "Find a table", action: { type: "set_field", field: "branch", value: null } as Action },
          { label: "Recommend something vegetarian", action: { type: "recommend", text: "Recommend something vegetarian" } },
        ],
      },
    ],
  };
}

function fresh(name: string): Saved {
  return { sessionId: uid(), items: [welcome(name)], draft: null, context: { lastCitedIds: [] }, pending: null, selected: null };
}

const NO_CARD: CardState = { submitting: false, locked: false, fieldErrors: null, done: false, message: null };

// A chat request with no reply after this long is given up, with Try again (failure-mode audit FM-015: a stuck request
// left "Still working on it" up for good, with every control disabled). The server bounds its own turn well below this,
// and a retry with the same request id joins the turn if it is still running.
const CHAT_TIMEOUT_MS = 90_000;
const TIMEOUT_TEXT = "This is taking much longer than usual. Please try again.";

/** Rendered in the browser only (ChatPanelClient), so the saved conversation is read synchronously, without a hydration pass. */
export function ChatPanel({ branches, restaurantName, scripted, header, branchCards = [], today, horizonDays = 30, onReady }: Props) {
  const [initial] = useState<Saved>(() => load() ?? fresh(restaurantName));
  const [s, setS] = useState<Saved>(initial);
  const [busy, setBusy] = useState(false);
  // After 8 seconds of waiting, say it's still working (a model that has to load can take longer; D-23).
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setSlow(true), 8_000);
    return () => {
      clearTimeout(t);
      setSlow(false);
    };
  }, [busy]);
  // A chat request that didn't get a reply, with why when the server said (D-24 audit: a 429 had no Try again).
  const [failed, setFailed] = useState<(ChatRequest & { why?: string }) | null>(null);
  const [card, setCard] = useState<CardState>(() => (initial.pending ? { ...NO_CARD, locked: initial.pending.unknown } : NO_CARD));
  const [text, setText] = useState("");
  const ref = useRef(initial);
  const inFlight = useRef(false);
  const posting = useRef(false); // a reservation POST in flight: chat turns wait (D-20 audit)
  const generation = useRef(0); // bumped by "New conversation" and "Start over", so late replies are dropped
  const listEnd = useRef<HTMLDivElement>(null);
  const restored = useRef(false);

  useLayoutEffect(() => onReady?.(), [onReady]);

  const update = useCallback((f: (prev: Saved) => Saved) => {
    const next = f(ref.current);
    ref.current = next;
    setS(next);
    save(next);
  }, []);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: "end" });
  }, [s.items.length, busy]);

  // ---------- chat turns ----------

  const history = (items: Item[]) =>
    items
      .filter((i) => i.id !== "welcome" && i.tone !== "error")
      .map((i) => ({ role: i.role, content: (i.role === "assistant" ? historyContent(i.text, i.blocks) : i.text).slice(0, i.role === "guest" ? 500 : 600) }))
      .filter((m) => m.content)
      .slice(-7);

  // User-timing marks per chat turn (D-24): send → response → painted, read by the latency benchmark. No guest text.
  const timeTurn = (id: string, phase: "send" | "response" | "painted", serverMs?: number) => {
    try {
      performance.mark(`chat:${phase}:${id}`);
      if (phase === "response") performance.measure(`chat-network:${id}`, { start: `chat:send:${id}`, end: `chat:response:${id}`, detail: { serverMs } });
      if (phase === "painted") performance.measure(`chat-total:${id}`, `chat:send:${id}`, `chat:painted:${id}`);
    } catch {
      /* timing is best effort */
    }
  };

  const send = useCallback(
    async (req: ChatRequest) => {
      // Synchronous guards (D-20): one chat turn at a time, and never while a booking is being submitted, so a late
      // chat reply can't rewrite the card or bring back a draft the booking just cleared.
      if (inFlight.current || posting.current) return;
      inFlight.current = true;
      const gen = generation.current;
      setBusy(true);
      setFailed(null);
      update((p) => ({ ...p, chatPending: req }));
      const cur = ref.current;
      timeTurn(req.requestId, "send");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), CHAT_TIMEOUT_MS);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          signal: abort.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: cur.sessionId, requestId: req.requestId, messages: req.messages, draft: cur.draft, context: cur.context, ...(req.action ? { action: req.action } : {}) }),
        });
        const j = await res.json().catch(() => null);
        if (gen !== generation.current) return; // the guest started over while this was in flight: drop the stale reply
        if (res.status === 429 || (res.status >= 500 && j?.error?.message)) {
          // Nothing was answered: the same request can be sent again with Try again (the server forgets a 429 or an
          // error), and the server's reason is shown (FM-028: a database being updated said only "couldn't reach").
          update((p) => ({ ...p, chatPending: null }));
          setFailed({ ...req, why: j?.error?.message ?? (res.status === 429 ? "You're sending messages quickly. Please wait a moment." : undefined) });
          return;
        }
        if (!res.ok || !j?.reply) throw new Error(`chat ${res.status}`);
        const r = j as Omit<TurnReply, "status" | "trace">;
        timeTurn(req.requestId, "response", r.meta?.latencyMs);
        const newCard = r.reply.blocks.some((b) => b.type === "confirm");
        if (newCard && !ref.current.pending) setCard(NO_CARD); // a pending or locked submit keeps its card state
        update((p) => ({
          ...p,
          items: [...p.items, { id: uid(), role: "assistant", text: r.reply.text, blocks: r.reply.blocks }],
          draft: r.draft,
          context: r.context,
          selected: r.draft.selected?.startsAt ?? (newCard ? p.selected : null),
          chatPending: null,
        }));
        requestAnimationFrame(() => requestAnimationFrame(() => timeTurn(req.requestId, "painted")));
      } catch {
        if (gen === generation.current) setFailed(abort.signal.aborted ? { ...req, why: TIMEOUT_TEXT } : req);
      } finally {
        clearTimeout(timer);
        inFlight.current = false;
        setBusy(false);
      }
    },
    [update],
  );

  const sendText = (raw: string) => {
    const t = raw.trim().slice(0, 500);
    if (!t || inFlight.current || posting.current || ref.current.pending?.unknown) return; // never leave a bubble send() refuses
    setText("");
    const prev = ref.current.items;
    update((p) => ({ ...p, items: [...p.items, { id: uid(), role: "guest", text: t }] }));
    void send({ messages: [...history(prev), { role: "guest", content: t }], requestId: uid() });
  };

  const sendAction = (action: Action, label: string) => {
    if (inFlight.current || posting.current || ref.current.pending?.unknown) return;
    const prev = ref.current.items;
    update((p) => ({ ...p, items: [...p.items, { id: uid(), role: "guest", text: label }], selected: action.type === "select_slot" ? action.startsAt : p.selected }));
    void send({ messages: [...history(prev), { role: "guest", content: label }], action, requestId: uid() });
  };

  // ---------- submit (D-14) ----------

  const confirmBlock = (): Extract<Block, { type: "confirm" }> | null => {
    for (const i of [...ref.current.items].reverse()) {
      const b = i.blocks?.find((x) => x.type === "confirm");
      if (b && b.type === "confirm") return b;
    }
    return null;
  };

  // What a POST found out (D-24 audit): Start over resets only after a known refusal; a booking or an unknown outcome
  // keeps the card (D-14: a new key could book twice).
  type PostResult = "booked" | "refused" | "unknown";
  const postOnce = useCallback(
    async (pending: Pending): Promise<PostResult> => {
      const c = confirmBlock();
      const branch = branches.find((b) => b.slug === pending.body.branch) ?? branches[0];
      setCard((x) => ({ ...x, submitting: true, message: null, fieldErrors: null }));
      let res: { status: number; body: unknown } | { networkError: true };
      try {
        const r = await fetch("/api/reservations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": pending.key }, body: JSON.stringify(pending.body) });
        res = { status: r.status, body: await r.json().catch(() => null) };
      } catch {
        res = { networkError: true };
      }
      const o = submitOutcome(res, { branch, branches, date: c?.date ?? "", partySize: pending.body.partySize });
      const status = "status" in res ? res.status : 0;
      // Replaying a submit whose outcome is unknown: a 429, 503 or network error still doesn't say whether the first
      // POST booked, so the card stays locked on Retry instead of treating it as "nothing was booked" (D-14, D-20 audit).
      if (pending.unknown && (o.unknown || status === 429 || status === 503)) {
        setCard({ submitting: false, locked: true, fieldErrors: null, done: false, message: "We still couldn't confirm whether your booking went through. Tap Retry in a moment." });
        update((p) => ({ ...p, pending: { ...pending, unknown: true } }));
        return "unknown";
      }
      if (o.clearDraft) generation.current += 1; // booked: any chat reply still on its way is now stale
      const inCard = o.unknown || o.fields !== null || status === 503 || status === 429;
      // A reply in the conversation (booked, or refused with a reason) is newer than any chat turn that failed before it,
      // so that turn's Try again goes (failure-mode audit FM-016: it could bring back a card for a slot just taken).
      if (!inCard) setFailed(null);
      setCard({ submitting: false, locked: o.unknown, fieldErrors: o.fields, done: o.clearDraft || (!inCard && !o.unknown), message: inCard ? o.text : null });
      update((p) => ({
        ...p,
        pending: o.clearPending ? null : { ...pending, unknown: true },
        draft: o.clearDraft ? null : p.draft,
        // Booked: the booking's facts are done with, but the guest's food preferences (an allergy) stay (review).
        context: o.clearDraft ? { ...p.context, lastCitedIds: [] } : p.context,
        chatPending: o.clearDraft || !inCard ? null : p.chatPending,
        cardFields: o.clearDraft ? null : p.cardFields, // booked: the typed name and mobile are not kept
        selected: o.clearDraft ? null : p.selected,
        items: inCard ? p.items : [...p.items, { id: uid(), role: "assistant", text: o.text, blocks: o.blocks }],
      }));
      return o.clearDraft ? "booked" : o.unknown ? "unknown" : "refused";
    },
    [branches, update],
  );

  const post = useCallback(
    async (pending: Pending): Promise<PostResult> => {
      if (posting.current) return "unknown"; // one POST at a time; a retry reuses the key anyway
      posting.current = true;
      try {
        return await postOnce(pending);
      } finally {
        posting.current = false;
      }
    },
    [postOnce],
  );

  const submit = (body: CreateBody) => {
    if (card.submitting || posting.current || inFlight.current) return; // a double tap sends once; never during a chat turn
    const prev = ref.current.pending;
    // A new key whenever any field changes; the same key only to retry an identical body (§5.9).
    const key = prev && JSON.stringify(prev.body) === JSON.stringify(body) ? prev.key : uid();
    const pending: Pending = { key, body, unknown: false };
    update((p) => ({ ...p, pending }));
    void post(pending);
  };

  const retry = () => {
    const p = ref.current.pending;
    if (p) void post(p);
  };

  const startOver = async () => {
    const p = ref.current.pending;
    if (p) {
      // Learn the outcome first (D-14): booked → show it; still unknown → stay locked, since a new key could book twice;
      // refused (taken, unavailable, invalid) → nothing was booked, so start over (D-24 audit: it never reset).
      if ((await post(p)) !== "refused") return;
    }
    setCard(NO_CARD);
    setFailed(null);
    generation.current += 1;
    update((prev) => ({ ...prev, pending: null, chatPending: null, cardFields: null, draft: null, selected: null, context: { lastCitedIds: [] }, items: [...prev.items, { ...welcome(restaurantName), id: uid(), text: "Let's start again. What would you like to do?" }] }));
  };

  // After a reload with a submit in flight, replay it with the same key to learn the outcome (D-14).
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    save(ref.current);
    // Whatever the stored flag says, the first POST may have reached the server: the replay is uncertain, so a 429 or
    // 503 keeps the card locked with Retry instead of reporting that nothing was booked (review).
    if (ref.current.pending) void post({ ...ref.current.pending, unknown: true });
    // A chat turn interrupted by a reload: offer Try again with the same request id (the server may already have it).
    else if (ref.current.chatPending) setFailed(ref.current.chatPending);
  }, [post]);

  const newConversation = () => {
    generation.current += 1;
    clear();
    const next = fresh(restaurantName);
    ref.current = next;
    setS(next);
    setCard(NO_CARD);
    setFailed(null);
    save(next);
  };

  // ---------- render ----------

  const lastAssistant = [...s.items].reverse().find((i) => i.role === "assistant" && i.tone !== "error");
  const locked = !!s.pending?.unknown;
  // While a submit's outcome is unknown, its card keeps Retry and Start over even if it isn't the latest reply (review UI-1).
  const pendingCardItem = locked ? [...s.items].reverse().find((i) => i.blocks?.some((b) => b.type === "confirm" && b.startsAtMs === s.pending!.body.startsAt)) : undefined;
  const composerLocked = locked || card.submitting;
  const handlers = (item: Item): BlockHandlers => ({
    active: item === lastAssistant && !busy && !locked && !card.submitting,
    onAction: sendAction,
    onText: (t) => sendText(t),
    selectedStartsAt: s.selected,
    branchCards,
    dateBounds: today ? { min: today, days: horizonDays } : null,
  });

  return (
    <section aria-label="Reservations and questions" className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        {header}
        {/* Long tokens (a pasted link) wrap instead of widening the conversation (failure-mode audit FM-017). */}
        <div aria-live="polite" aria-relevant="additions" className="space-y-5 px-4 py-5 wrap-anywhere">
          {s.items.map((item) => (
            <div key={item.id} className={item.role === "guest" ? "flex justify-end" : "flex gap-2.5"}>
              {item.role === "guest" ? (
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-neem px-4 py-2.5 text-[16px] text-white">{item.text}</p>
              ) : (
                <>
                  <span aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neem-tint text-neem">
                    <LeafMark className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-3">
                    {item.text && (
                      <p className={`w-fit max-w-full rounded-2xl rounded-tl-md border border-line bg-paper px-4 py-2.5 text-[16px] leading-relaxed ${item.tone === "error" ? "text-warn" : "text-ink"}`}>{item.text}</p>
                    )}
                    {item.blocks?.map((b, k) =>
                      b.type === "confirm" ? (
                        <ConfirmCard
                          key={`${b.startsAtMs}-${k}`}
                          block={b}
                          state={item === lastAssistant || item === pendingCardItem ? card : { ...NO_CARD, done: true }}
                          initial={s.pending?.body.startsAt === b.startsAtMs ? s.pending.body : s.cardFields?.startsAt === b.startsAtMs ? s.cardFields : null}
                          onFields={(f) => update((p) => ({ ...p, cardFields: { startsAt: b.startsAtMs, ...f } }))}
                          active={(item === lastAssistant || item === pendingCardItem) && !busy}
                          onSubmit={submit}
                          onRetry={retry}
                          onStartOver={startOver}
                        />
                      ) : (
                        <BlockView key={k} block={b} h={handlers(item)} />
                      ),
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex gap-2.5">
              <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neem-tint text-neem">
                <LeafMark className="h-5 w-5" />
              </span>
              {/* A status region, so the change to "Still working…" is announced too (D-24 audit: the list only announces
                  additions). */}
              <p role="status" className="flex items-center gap-2 rounded-2xl rounded-tl-md border border-line bg-paper px-4 py-2.5 text-muted" aria-label="Checking">
                {/* The dot pulses, not the text: faded text failed the contrast check mid-pulse (D-23). */}
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-neem motion-safe:animate-pulse" />
                <span>{slow ? "Still working on it, one moment…" : "Checking…"}</span>
              </p>
            </div>
          )}
          {failed && (
            <div role="alert" className="space-y-2 rounded-xl bg-warn-tint px-4 py-3">
              <p className="text-warn">{failed.why ?? "We couldn't reach the restaurant just now. Check your connection and try again."}</p>
              <button type="button" onClick={() => void send({ messages: failed.messages, action: failed.action, requestId: failed.requestId })} disabled={composerLocked} className="min-h-11 rounded-full border border-line bg-paper px-4 hover:border-neem hover:text-neem disabled:opacity-50">
                Try again
              </button>
            </div>
          )}
          <div ref={listEnd} />
        </div>
      </div>
      <form
        className="border-t border-line bg-paper px-4 pt-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          sendText(text);
        }}
      >
        <div>
          <div className="flex items-center gap-2">
            <label htmlFor="composer" className="sr-only">
              Your message
            </label>
            <input
              id="composer"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={500}
              autoComplete="off"
              disabled={composerLocked}
              placeholder={composerLocked ? "Finish or retry your booking above first" : "Type a message…"}
              className="min-h-12 flex-1 rounded-full border border-line bg-ash px-5 text-[16px] text-ink placeholder:text-muted disabled:opacity-70"
            />
            <button type="submit" aria-label="Send" disabled={busy || composerLocked || !text.trim()} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-neem text-white hover:bg-neem-dark disabled:opacity-40">
              <ArrowUpIcon className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-sm text-muted">
            <button type="button" onClick={newConversation} disabled={locked || card.submitting || busy} className="min-h-11 underline decoration-line underline-offset-4 hover:text-neem disabled:opacity-50">
              New conversation
            </button>
            {scripted && <span className="rounded-full border border-line px-2.5 py-0.5">Scripted model (test)</span>}
          </div>
        </div>
      </form>
    </section>
  );
}
