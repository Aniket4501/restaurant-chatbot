"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { historyContent, submitOutcome, type SubmitBranch } from "@/lib/chat/submit";
import type { Action, Block, TurnReply } from "@/lib/chat/types";
import { BlockView, type BlockHandlers } from "@/components/chat/Blocks";
import { ConfirmCard, type CardState } from "@/components/chat/ConfirmCard";
import { clear, load, save, type CreateBody, type Item, type Pending, type Saved } from "@/components/chat/storage";

// The reservations-and-questions panel (§5.7 client side, §5.10, D-14).
// - Typed messages and chip/slot taps go to POST /api/chat; the server returns the reply, blocks and new draft.
// - The confirm card POSTs to /api/reservations with an Idempotency-Key. { key, body } is stored before the POST and
//   replayed on reload. A confirmation is shown only from a 201/200 body (BR-12), via the shared submitOutcome.
// - While a submit's outcome is unknown, the card, chips and times are locked; the guest can Retry or Start over.

type Props = { branches: SubmitBranch[]; restaurantName: string; scripted: boolean };
type ChatRequest = { messages: { role: "guest" | "assistant"; content: string }[]; action?: Action };

const uid = () => crypto.randomUUID();

function welcome(name: string, branches: SubmitBranch[]): Item {
  return {
    id: "welcome",
    role: "assistant",
    text: `Welcome to ${name}. Ask about our menu, opening hours or branches, or book a table.`,
    blocks: [
      {
        type: "quick_replies",
        chips: [
          ...branches.map((b) => ({ label: `Book at ${b.short}`, action: { type: "set_field", field: "branch", value: b.slug } as Action })),
          { label: "Opening hours", text: "What are your opening hours?" },
          { label: "Menu", text: "What's on the menu?" },
        ],
      },
    ],
  };
}

function fresh(name: string, branches: SubmitBranch[]): Saved {
  return { sessionId: uid(), items: [welcome(name, branches)], draft: null, context: { lastCitedIds: [] }, pending: null, selected: null };
}

const NO_CARD: CardState = { submitting: false, locked: false, fieldErrors: null, done: false, message: null };

/** Rendered in the browser only (ChatPanelClient), so the saved conversation is read synchronously, without a hydration pass. */
export function ChatPanel({ branches, restaurantName, scripted }: Props) {
  const [initial] = useState<Saved>(() => load() ?? fresh(restaurantName, branches));
  const [s, setS] = useState<Saved>(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ChatRequest | null>(null);
  const [card, setCard] = useState<CardState>(() => (initial.pending ? { ...NO_CARD, locked: initial.pending.unknown } : NO_CARD));
  const [text, setText] = useState("");
  const ref = useRef(initial);
  const listEnd = useRef<HTMLDivElement>(null);
  const restored = useRef(false);

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

  const send = useCallback(
    async (req: ChatRequest) => {
      setBusy(true);
      setFailed(null);
      const cur = ref.current;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: cur.sessionId, messages: req.messages, draft: cur.draft, context: cur.context, ...(req.action ? { action: req.action } : {}) }),
        });
        const j = await res.json().catch(() => null);
        if (res.status === 429) {
          update((p) => ({ ...p, items: [...p.items, { id: uid(), role: "assistant", text: j?.error?.message ?? "You're sending messages quickly. Please wait a moment.", tone: "error" }] }));
          return;
        }
        if (!res.ok || !j?.reply) throw new Error(`chat ${res.status}`);
        const r = j as Omit<TurnReply, "status" | "trace">;
        const newCard = r.reply.blocks.some((b) => b.type === "confirm");
        if (newCard && !ref.current.pending?.unknown) setCard(NO_CARD); // a locked card stays locked
        update((p) => ({
          ...p,
          items: [...p.items, { id: uid(), role: "assistant", text: r.reply.text, blocks: r.reply.blocks }],
          draft: r.draft,
          context: r.context,
          selected: r.draft.selected?.startsAt ?? (newCard ? p.selected : null),
          // A new confirm card means the slot or party changed: forget any settled pending entry (D-14).
          pending: newCard && p.pending && !p.pending.unknown ? null : p.pending,
        }));
      } catch {
        setFailed(req);
      } finally {
        setBusy(false);
      }
    },
    [update],
  );

  const sendText = (raw: string) => {
    const t = raw.trim().slice(0, 500);
    if (!t || busy || ref.current.pending?.unknown) return;
    setText("");
    const prev = ref.current.items;
    update((p) => ({ ...p, items: [...p.items, { id: uid(), role: "guest", text: t }] }));
    void send({ messages: [...history(prev), { role: "guest", content: t }] });
  };

  const sendAction = (action: Action, label: string) => {
    if (busy || ref.current.pending?.unknown) return;
    const prev = ref.current.items;
    update((p) => ({ ...p, items: [...p.items, { id: uid(), role: "guest", text: label }], selected: action.type === "select_slot" ? action.startsAt : p.selected }));
    void send({ messages: [...history(prev), { role: "guest", content: label }], action });
  };

  // ---------- submit (D-14) ----------

  const confirmBlock = (): Extract<Block, { type: "confirm" }> | null => {
    for (const i of [...ref.current.items].reverse()) {
      const b = i.blocks?.find((x) => x.type === "confirm");
      if (b && b.type === "confirm") return b;
    }
    return null;
  };

  const post = useCallback(
    async (pending: Pending) => {
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
      const inCard = o.unknown || o.fields !== null || status === 503 || status === 429;
      setCard({ submitting: false, locked: o.unknown, fieldErrors: o.fields, done: o.clearDraft || (!inCard && !o.unknown), message: inCard ? o.text : null });
      update((p) => ({
        ...p,
        pending: o.clearPending ? null : { ...pending, unknown: true },
        draft: o.clearDraft ? null : p.draft,
        context: o.clearDraft ? { lastCitedIds: [] } : p.context,
        selected: o.clearDraft ? null : p.selected,
        items: inCard ? p.items : [...p.items, { id: uid(), role: "assistant", text: o.text, blocks: o.blocks }],
      }));
    },
    [branches, update],
  );

  const submit = (body: CreateBody) => {
    if (card.submitting) return; // a double tap sends once; a retry reuses the key anyway
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
      // Learn the outcome first (D-14): booked → show it; still unknown → stay locked, since a new key could book twice.
      await post(p);
      if (ref.current.pending?.unknown) return;
      if (!ref.current.pending && ref.current.draft === null) return;
    }
    setCard(NO_CARD);
    update((prev) => ({ ...prev, pending: null, draft: null, selected: null, context: { lastCitedIds: [] }, items: [...prev.items, { ...welcome(restaurantName, branches), id: uid(), text: "Let's start again. What would you like to do?" }] }));
  };

  // After a reload with a submit in flight, replay it with the same key to learn the outcome (D-14).
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    save(ref.current);
    if (ref.current.pending) void post(ref.current.pending);
  }, [post]);

  const newConversation = () => {
    clear();
    const next = fresh(restaurantName, branches);
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
    active: item === lastAssistant && !busy && !locked,
    onAction: sendAction,
    onText: (t) => sendText(t),
    selectedStartsAt: s.selected,
  });

  return (
    <section aria-label="Reservations and questions" className="flex min-h-0 flex-1 flex-col">
      <div aria-live="polite" aria-relevant="additions" className="flex-1 space-y-5 overflow-y-auto px-4 py-6 sm:px-8">
        {s.items.map((item) => (
          <div key={item.id} className={item.role === "guest" ? "flex justify-end" : ""}>
            {item.role === "guest" ? (
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-paper px-4 py-2.5 text-[16px] text-ink shadow-[0_1px_0_var(--line)]">{item.text}</p>
            ) : (
              <div className="max-w-[40rem] space-y-3">
                {item.text && <p className={`text-[16px] leading-relaxed ${item.tone === "error" ? "text-warn" : "text-ink"}`}>{item.text}</p>}
                {item.blocks?.map((b, k) =>
                  b.type === "confirm" ? (
                    <ConfirmCard
                      key={`${b.startsAtMs}-${k}`}
                      block={b}
                      state={item === lastAssistant || item === pendingCardItem ? card : { ...NO_CARD, done: true }}
                      initial={s.pending?.body.startsAt === b.startsAtMs ? s.pending.body : null}
                      active={item === lastAssistant || item === pendingCardItem}
                      onSubmit={submit}
                      onRetry={retry}
                      onStartOver={startOver}
                    />
                  ) : (
                    <BlockView key={k} block={b} h={handlers(item)} />
                  ),
                )}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <p className="text-muted" aria-label="Checking">
            <span className="inline-block animate-pulse">Checking…</span>
          </p>
        )}
        {failed && (
          <div role="alert" className="space-y-2">
            <p className="text-warn">We couldn&apos;t reach the restaurant just now. Check your connection and try again.</p>
            <button type="button" onClick={() => void send(failed)} disabled={composerLocked} className="min-h-11 rounded-md border border-line bg-paper px-4 hover:border-neem hover:text-neem disabled:opacity-50">
              Try again
            </button>
          </div>
        )}
        <div ref={listEnd} />
      </div>
      <form
        className="border-t border-line bg-ash px-4 py-3 sm:px-8"
        onSubmit={(e) => {
          e.preventDefault();
          sendText(text);
        }}
      >
        <div className="flex items-end gap-2">
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
            placeholder={composerLocked ? "Finish or retry your booking above first" : "Ask a question, or tell us when you'd like to come"}
            className="min-h-11 flex-1 rounded-md border border-line bg-white px-3 text-[16px] text-ink placeholder:text-muted disabled:bg-ash"
          />
          <button type="submit" disabled={busy || composerLocked || !text.trim()} className="min-h-11 rounded-md bg-neem px-5 text-[15px] font-medium text-white hover:bg-neem-dark disabled:opacity-50">
            Send
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between text-sm text-muted">
          <button type="button" onClick={newConversation} disabled={locked || card.submitting} className="min-h-11 underline decoration-line underline-offset-4 hover:text-neem disabled:opacity-50">
            New conversation
          </button>
          {scripted && <span className="rounded-full border border-line px-2.5 py-0.5">Scripted model (test)</span>}
        </div>
      </form>
    </section>
  );
}
