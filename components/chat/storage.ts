import type { Action, Block, Draft, TurnContext } from "@/lib/chat/types";

// Conversation state kept in sessionStorage across reloads (§5.10), including a pending submit (D-14): { key, body }
// is written before the POST, so a reload can replay it with the same Idempotency-Key. Storage may be unavailable
// (private windows, blocked storage); every access is wrapped and the page still works without it.

export type Item = { id: string; role: "guest" | "assistant"; text: string; blocks?: Block[]; tone?: "error" };
export type CreateBody = { branch: string; startsAt: number; partySize: number; name: string; phone: string; email: string | null; note: string | null };
export type Pending = { key: string; body: CreateBody; unknown: boolean };
/** A chat request sent but not yet answered, kept so a reload can offer "Try again" with the same request id (D-20). */
export type ChatPending = { messages: { role: "guest" | "assistant"; content: string }[]; action?: Action; requestId: string };
/** What the guest has typed into the confirm card for a slot, so a card shown again (or a reload) keeps it (D-21). */
export type CardFields = { startsAt: number; name: string; phone: string; email: string; note: string };
export type Saved = { sessionId: string; items: Item[]; draft: Draft | null; context: TurnContext; pending: Pending | null; selected: number | null; chatPending?: ChatPending | null; cardFields?: CardFields | null };

const KEY = "neem-ember-chat-v1";

export function load(): Saved | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export function save(s: Saved): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the conversation simply won't survive a reload */
  }
}

export function clear(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
