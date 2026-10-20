"use client";

import { useState } from "react";
import type { Block } from "@/lib/chat/types";
import type { CreateBody } from "@/components/chat/storage";

// The confirm card (§5.10, BR-09, D-14): repeats branch, date, time and party, and asks for name and mobile
// (+91 prefilled), optional email and note. Confirm disables while submitting. If the outcome is unknown (lost
// response, 5xx), the fields lock and the guest can only Retry with the same key or Start over.

type Confirm = Extract<Block, { type: "confirm" }>;
export type CardState = { submitting: boolean; locked: boolean; fieldErrors: Record<string, string> | null; done: boolean; message: string | null };

const input =
  "mt-1 block min-h-11 w-full rounded-md border border-line bg-white px-3 text-[16px] text-ink placeholder:text-muted/70 disabled:bg-ash disabled:text-muted aria-[invalid=true]:border-warn";

export function ConfirmCard({ block, state, initial, active, onSubmit, onRetry, onStartOver }: {
  block: Confirm;
  state: CardState;
  initial: Partial<CreateBody> | null;
  active: boolean;
  onSubmit: (body: CreateBody) => void;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "+91 ");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const disabled = !active || state.submitting || state.locked || state.done;
  const err = state.fieldErrors ?? {};
  const id = `card-${block.startsAtMs}`;

  return (
    <form
      aria-label="Confirm your booking"
      className="rounded-lg border border-line bg-paper p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        onSubmit({ branch: block.branch, startsAt: block.startsAtMs, partySize: block.partySize, name: name.trim(), phone: phone.trim(), email: email.trim() || null, note: note.trim() || null });
      }}
    >
      <h3 className="font-display text-xl text-ink">
        {block.dateLabel}, {block.timeLabel}
      </h3>
      <p className="mt-1 text-[15px] text-muted">
        {block.partySize} {block.partySize === 1 ? "guest" : "guests"} at {block.branchName}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-[15px]" htmlFor={`${id}-name`}>
          Name
          <input id={`${id}-name`} className={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} disabled={disabled} aria-invalid={!!err.name} aria-describedby={err.name ? `${id}-name-err` : undefined} />
          {err.name && <span id={`${id}-name-err`} className="mt-1 block text-sm text-warn">{err.name}</span>}
        </label>
        <label className="block text-[15px]" htmlFor={`${id}-phone`}>
          Mobile number
          <input id={`${id}-phone`} className={input} value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" required disabled={disabled} aria-invalid={!!err.phone} aria-describedby={err.phone ? `${id}-phone-err` : undefined} />
          {err.phone && <span id={`${id}-phone-err`} className="mt-1 block text-sm text-warn">{err.phone}</span>}
        </label>
        <label className="block text-[15px]" htmlFor={`${id}-email`}>
          Email <span className="text-muted">(optional)</span>
          <input id={`${id}-email`} className={input} value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" disabled={disabled} aria-invalid={!!err.email} />
          {err.email && <span className="mt-1 block text-sm text-warn">{err.email}</span>}
        </label>
        <label className="block text-[15px] sm:col-span-2" htmlFor={`${id}-note`}>
          Note for the restaurant <span className="text-muted">(optional)</span>
          <textarea id={`${id}-note`} className={`${input} min-h-20 py-2`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} disabled={disabled} aria-invalid={!!err.note} />
          {err.note && <span className="mt-1 block text-sm text-warn">{err.note}</span>}
        </label>
      </div>
      {state.message && (
        <p role="alert" className="mt-4 rounded-md bg-warn-tint px-4 py-2.5 text-[15px] text-warn">
          {state.message}
        </p>
      )}
      {state.locked ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onRetry} disabled={state.submitting} className="min-h-11 rounded-md bg-neem px-5 text-[15px] font-medium text-white hover:bg-neem-dark disabled:opacity-60">
            {state.submitting ? "Checking…" : "Retry"}
          </button>
          <button type="button" onClick={onStartOver} disabled={state.submitting} className="min-h-11 rounded-md border border-line bg-paper px-5 text-[15px] hover:border-neem hover:text-neem disabled:opacity-60">
            Start over
          </button>
        </div>
      ) : (
        !state.done && (
          <button type="submit" disabled={disabled} className="mt-4 min-h-11 rounded-md bg-neem px-6 text-[15px] font-medium text-white hover:bg-neem-dark disabled:opacity-60">
            {state.submitting ? "Confirming…" : "Confirm"}
          </button>
        )
      )}
    </form>
  );
}
