"use client";

import type { ReactElement } from "react";
import type { Action, Block, Chip, SlotChip } from "@/lib/chat/types";
import { CalendarIcon, CheckIcon, ClockIcon, MenuBookIcon } from "@/components/ui/icons";

// Renderers for the blocks /api/chat returns (§5.9, §5.10). Chips and times are real buttons with 44 px targets.
// Only the latest reply is interactive; earlier ones stay visible but disabled, so an old chip can't act on a draft
// that has moved on.

export type BlockHandlers = {
  active: boolean;
  onAction: (action: Action, label: string) => void;
  onText: (text: string) => void;
  selectedStartsAt: number | null;
};

const chipClass =
  "inline-flex min-h-11 items-center rounded-full border border-line bg-paper px-4 text-[15px] text-ink transition-colors hover:border-neem hover:bg-neem-tint hover:text-neem-dark disabled:cursor-default disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-paper disabled:hover:text-ink";

// The welcome's quick actions render as icon tiles; any other quick replies stay chips.
const TILE_ICONS: Record<string, (p: { className?: string }) => ReactElement> = { Menu: MenuBookIcon, "Opening hours": ClockIcon, "Book a table": CalendarIcon };

function ChipButton({ chip, h }: { chip: Chip; h: BlockHandlers }) {
  return (
    <button type="button" className={chipClass} disabled={!h.active} onClick={() => ("action" in chip ? h.onAction(chip.action, chip.label) : h.onText(chip.text))}>
      {chip.label}
    </button>
  );
}

function Chips({ chips, h, label }: { chips: Chip[]; h: BlockHandlers; label: string }) {
  if (chips.length > 1 && chips.every((c) => TILE_ICONS[c.label]))
    return (
      <div role="group" aria-label={label} className="grid grid-cols-3 gap-2">
        {chips.map((c) => {
          const Icon = TILE_ICONS[c.label];
          return (
            <button
              key={c.label}
              type="button"
              disabled={!h.active}
              onClick={() => ("action" in c ? h.onAction(c.action, c.label) : h.onText(c.text))}
              className="flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl border border-line bg-paper px-2 py-3 text-[14px] leading-tight text-ink transition-colors hover:border-neem hover:bg-neem-tint disabled:cursor-default disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-paper"
            >
              <Icon className="h-6 w-6 text-neem" />
              {c.label}
            </button>
          );
        })}
      </div>
    );
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <ChipButton key={c.label} chip={c} h={h} />
      ))}
    </div>
  );
}

function TimeButton({ slot, h }: { slot: SlotChip; h: BlockHandlers }) {
  const selected = h.selectedStartsAt === slot.startsAtMs;
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={!h.active}
      onClick={() => h.onAction(slot.action, `${slot.dateLabel}, ${slot.label.split(" · ").at(-1)} at ${slot.branchName.split(", ").pop()}`)}
      className={`min-h-11 w-full rounded-lg border px-2 text-[15px] tabular-nums transition-colors disabled:cursor-default ${
        selected ? "border-neem bg-neem text-white" : "border-line bg-paper text-ink hover:border-neem hover:text-neem disabled:opacity-50 disabled:hover:border-line disabled:hover:text-ink"
      }`}
    >
      {slot.label}
    </button>
  );
}

function Slots({ block, h }: { block: Extract<Block, { type: "slots" }>; h: BlockHandlers }) {
  if (!block.groups.length && !block.alternatives.length) return null;
  return (
    <section aria-label={block.heading} className="rounded-xl border border-line bg-paper p-4">
      <h3 className="flex items-center gap-2 font-display text-lg text-ink">
        <CalendarIcon className="h-5 w-5 shrink-0 text-neem" />
        {block.heading}
      </h3>
      {block.groups.map((g) => (
        <div key={g.service} className="mt-4">
          <h4 className="text-[15px] font-medium text-ink">{g.service === "lunch" ? "Lunch" : "Dinner"}</h4>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {g.slots.map((s) => (
              <TimeButton key={s.startsAtMs} slot={s} h={h} />
            ))}
          </div>
        </div>
      ))}
      {block.alternatives.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <h4 className="text-[15px] font-medium text-ink">Other options</h4>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {block.alternatives.map((s) => (
              <TimeButton key={`${s.branch}-${s.startsAtMs}`} slot={s} h={h} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function Confirmation({ block }: { block: Extract<Block, { type: "confirmation" }> }) {
  return (
    <section data-confirmation-ref={block.ref} aria-label={`Booking ${block.ref}`} className="rounded-xl border border-line border-l-4 border-l-neem bg-paper p-5">
      <h3 className="flex items-center gap-2 font-display text-xl text-ink">
        <CheckIcon className="h-6 w-6 text-neem" />
        Your table is booked
      </h3>
      <p className="mt-3 text-sm text-muted">Booking reference</p>
      <p className="font-display text-3xl tracking-wide text-neem">{block.ref}</p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[15px]">
        <dt className="text-muted">When</dt>
        <dd>
          {block.dateLabel}, {block.timeLabel}
        </dd>
        <dt className="text-muted">Guests</dt>
        <dd>{block.partySize}</dd>
        <dt className="text-muted">Name</dt>
        <dd>{block.guestName}</dd>
        <dt className="text-muted">Where</dt>
        <dd>
          {block.branchName}
          <br />
          <span className="text-muted">{block.address}</span>
        </dd>
        <dt className="text-muted">Phone</dt>
        <dd>
          <a className="underline decoration-line underline-offset-4 hover:text-neem" href={`tel:${block.phone}`}>
            {block.phone}
          </a>
        </dd>
      </dl>
    </section>
  );
}

export function BlockView({ block, h }: { block: Block; h: BlockHandlers }) {
  switch (block.type) {
    case "quick_replies":
      return <Chips chips={block.chips} h={h} label="Suggestions" />;
    case "field_request":
      return <Chips chips={block.chips} h={h} label={block.prompt} />;
    case "slots":
      return <Slots block={block} h={h} />;
    case "info":
      return (
        <ul className="space-y-1.5 rounded-xl border border-line bg-paper p-4 text-[15px]">
          {block.items.map((i) => (
            <li key={i.id}>{i.text}</li>
          ))}
        </ul>
      );
    case "notice":
      return (
        <p role="status" className={`rounded-lg px-4 py-2.5 text-[15px] ${block.tone === "warning" ? "bg-warn-tint text-warn" : "bg-neem-tint text-neem-dark"}`}>
          {block.text}
        </p>
      );
    case "confirmation":
      return <Confirmation block={block} />;
    case "confirm":
      return null; // rendered by ChatPanel, which owns the submit state
  }
}
