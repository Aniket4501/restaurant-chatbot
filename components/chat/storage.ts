import type { Block, Draft } from "@/lib/chat/types";

// Conversation state kept in sessionStorage across reloads (§5.10), including a pending submit (D-14): { key, body }
// is written before the POST, so a reload can replay it with the same Idempotency-Key. Storage may be unavailable
// (private windows, blocked storage); every access is wrapped and the page still works without it.

export type Item = { id: string; role: "guest" | "assistant"; text: string; blocks?: Block[]; tone?: "error" };
export type CreateBody = { branch: string; startsAt: number; partySize: number; name: string; phone: string; email: string | null; note: string | null };
export type Pending = { key: string; body: CreateBody; unknown: boolean };
export type Saved = { sessionId: string; items: Item[]; draft: Draft | null; context: { lastCitedIds: string[] }; pending: Pending | null; selected: number | null };

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
