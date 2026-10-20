"use client";

import { useId, type ReactElement } from "react";
import type { Action, Block, Chip, MenuItemView, SlotChip } from "@/lib/chat/types";
import { CalendarIcon, CheckIcon, ChevronIcon, ClockIcon, DishIcon, LeafMark, MenuBookIcon, PinIcon } from "@/components/ui/icons";

// Renderers for the blocks /api/chat returns (§5.9, §5.10). Chips and times are real buttons with 44 px targets.
// Only the latest reply is interactive; earlier ones stay visible but disabled, so an old chip can't act on a draft
// that has moved on.

export type BranchCard = { slug: string; short: string; address: string; status: { open: boolean; text: string } };

export type BlockHandlers = {
  active: boolean;
  onAction: (action: Action, label: string) => void;
  onText: (text: string) => void;
  selectedStartsAt: number | null;
  /** Branch details for the branch question (mobile-first redesign); without them it falls back to chips. */
  branchCards?: BranchCard[];
  /** Today (branch-local) and the booking horizon, for the slot picker's previous/next day. */
  dateBounds?: { min: string; days: number } | null;
};

/** "2026-10-17" ± days, as pure date arithmetic (no clock). */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const shortDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
};

/** The branch question as cards: name, address and today's status, like the user's mockup (no photos). */
function BranchCards({ chips, h, label }: { chips: Chip[]; h: BlockHandlers; label: string }) {
  return (
    <div role="group" aria-label={label} className="space-y-2.5">
      {chips.map((c) => {
        const slug = "action" in c && c.action.type === "set_field" ? c.action.value : null;
        const b = h.branchCards?.find((x) => x.slug === slug);
        const id = `branch-${slug}`;
        // The button holds only the name, so its accessible name is its visible label (WCAG 2.5.3); an overlay makes
        // the whole card the tap target, and the address and status are its description.
        return (
          <div
            key={c.label}
            className="relative flex items-center gap-3 rounded-2xl border border-line bg-paper p-2.5 transition-colors has-[button:disabled]:opacity-50 has-[button:enabled:hover]:border-neem has-[button:focus-visible]:outline-3 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-neem"
          >
            <span aria-hidden className="flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-xl bg-smoke text-smoke-muted">
              <LeafMark className="h-9 w-9" />
            </span>
            <span className="min-w-0 flex-1">
              <button
                type="button"
                aria-describedby={b ? id : undefined}
                disabled={!h.active}
                onClick={() => ("action" in c ? h.onAction(c.action, c.label) : h.onText(c.text))}
                className="block text-left font-display text-[19px] leading-tight text-ink after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none disabled:cursor-default"
              >
                {c.label}
              </button>
              {b && (
                <span id={id} className="mt-1 block space-y-0.5 text-[13px] text-muted">
                  <span className="flex gap-1.5">
                    <PinIcon className="mt-px h-4 w-4 shrink-0" />
                    <span className="line-clamp-2">{b.address}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <ClockIcon className="h-4 w-4 shrink-0" />
                    <span className={b.status.open ? "text-neem-dark" : ""}>{b.status.text}</span>
                  </span>
                </span>
              )}
            </span>
            <ChevronIcon className="h-5 w-5 shrink-0 text-muted" />
          </div>
        );
      })}
    </div>
  );
}

const chipClass =
  "inline-flex min-h-11 items-center rounded-full border border-line bg-paper px-4 text-[15px] text-ink transition-colors hover:border-neem hover:bg-neem-tint hover:text-neem-dark disabled:cursor-default disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-paper disabled:hover:text-ink";

// The welcome's starting points render as icon tiles; any other quick replies stay chips.
const TILE_ICONS: Record<string, (p: { className?: string }) => ReactElement> = {
  "Help me find a dish": DishIcon,
  "Show me the menu": MenuBookIcon,
  "Find a table": CalendarIcon,
  "Recommend something vegetarian": LeafMark,
};

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
      <div role="group" aria-label={label} className="grid grid-cols-2 gap-2">
        {chips.map((c) => {
          const Icon = TILE_ICONS[c.label];
          return (
            <button
              key={c.label}
              type="button"
              disabled={!h.active}
              onClick={() => ("action" in c ? h.onAction(c.action, c.label) : h.onText(c.text))}
              className="flex min-h-[4.25rem] items-center gap-2.5 rounded-xl border border-line bg-paper px-3 py-2.5 text-left text-[14px] leading-snug text-ink transition-colors hover:border-neem hover:bg-neem-tint disabled:cursor-default disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-paper"
            >
              <Icon className="h-6 w-6 shrink-0 text-neem" />
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

function DateStep({ date, dir, h }: { date: string; dir: -1 | 1; h: BlockHandlers }) {
  const b = h.dateBounds;
  const to = shiftDate(date, dir);
  const out = !b || to < b.min || to > shiftDate(b.min, b.days);
  const label = shortDate(to);
  return (
    <button
      type="button"
      aria-label={`${dir < 0 ? "Earlier" : "Later"} date: ${label}`}
      disabled={!h.active || out}
      onClick={() => h.onAction({ type: "set_field", field: "date", value: to }, label)}
      className="flex h-11 w-11 items-center justify-center rounded-full border border-line text-ink hover:border-neem hover:text-neem disabled:cursor-default disabled:opacity-35 disabled:hover:border-line disabled:hover:text-ink"
    >
      <ChevronIcon dir={dir < 0 ? "left" : "right"} className="h-5 w-5" />
    </button>
  );
}

function Slots({ block, h }: { block: Extract<Block, { type: "slots" }>; h: BlockHandlers }) {
  if (!block.groups.length && !block.alternatives.length) return null;
  // Previous/next day on a day's times; not on the "Other options" list after a failed submit (no groups).
  const nav = !!h.dateBounds && !!block.date && (block.groups.length > 0 || (block.reason !== null && block.reason !== "time_unavailable"));
  return (
    <section aria-label={block.heading} className="rounded-2xl border border-line bg-paper p-4">
      <div className="flex items-center gap-2">
        <h3 className="flex min-w-0 flex-1 items-center gap-2 font-display text-lg leading-snug text-ink">
          <CalendarIcon className="h-5 w-5 shrink-0 text-neem" />
          {block.heading}
        </h3>
        {nav && (
          <div className="flex shrink-0 gap-1.5">
            <DateStep date={block.date} dir={-1} h={h} />
            <DateStep date={block.date} dir={1} h={h} />
          </div>
        )}
      </div>
      {block.groups.map((g) => (
        <div key={g.service} className="mt-4">
          <h4 className="text-[15px] font-medium text-ink">{g.service === "lunch" ? "Lunch" : "Dinner"}</h4>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {g.slots.map((s) => (
              <TimeButton key={s.startsAtMs} slot={s} h={h} />
            ))}
          </div>
        </div>
      ))}
      {block.alternatives.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <h4 className="text-[15px] font-medium text-ink">Other options</h4>
          <div className="mt-2 grid grid-cols-1 gap-2">
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

const SPICE = ["Not spicy", "Mild", "Medium spicy", "Hot"];

function Labels({ item }: { item: MenuItemView }) {
  if (!item.labels.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {item.labels.map((l) => (
        <span key={l} className="rounded-full bg-neem-tint px-2 py-0.5 text-[12px] text-neem-dark">
          {l}
        </span>
      ))}
    </span>
  );
}

const price = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** A suggested dish (D-20): every word here comes from the menu table, never from the model. */
function DishCard({ item }: { item: MenuItemView }) {
  const facts = [item.spice === null ? null : (SPICE[item.spice] ?? "Hot"), item.contains.length ? `Contains ${item.contains.join(", ")}` : null, item.scope].filter(Boolean).join(" · ");
  return (
    <article aria-label={`${item.name}, ${price(item.price)}`} className="rounded-2xl border border-line bg-paper p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-[19px] leading-tight text-ink">{item.name}</h3>
        <span className="shrink-0 text-[16px] font-medium text-neem tabular-nums">{price(item.price)}</span>
      </div>
      <p className="mt-0.5 text-[13px] text-muted">{item.courseLabel}</p>
      <p className="mt-2 text-[15px] leading-relaxed text-ink">{item.description}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Labels item={item} />
        <span className="text-[13px] text-muted">{facts}</span>
      </div>
    </article>
  );
}

function DishRow({ item }: { item: MenuItemView }) {
  return (
    <li className="py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[15px] font-medium text-ink">{item.name}</span>
        <span className="shrink-0 text-[15px] text-neem tabular-nums">{price(item.price)}</span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{item.description}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Labels item={item} />
        {(item.contains.length > 0 || item.scope) && <span className="text-[12px] text-muted">{[item.contains.length ? `Contains ${item.contains.join(", ")}` : null, item.scope].filter(Boolean).join(" · ")}</span>}
      </div>
    </li>
  );
}

function Recommendation({ block }: { block: Extract<Block, { type: "recommendation" }> }) {
  const [lead, ...rest] = block.items;
  const rows = block.lead ? rest : block.items;
  const titleId = useId();
  return (
    <div className="space-y-2">
      {block.lead && lead && <DishCard item={lead} />}
      {rows.length > 0 && (
        <div role="group" aria-labelledby={titleId} className="rounded-2xl border border-line bg-paper px-4 py-1.5">
          <p id={titleId} className={block.lead ? "pt-2 text-[13px] text-muted" : "sr-only"}>
            {block.lead ? "Also worth a look" : "Dishes that fit"}
          </p>
          <ul className="divide-y divide-line">
            {rows.map((i) => (
              <DishRow key={i.id} item={i} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MenuList({ block }: { block: Extract<Block, { type: "menu_list" }> }) {
  const baseId = useId();
  return (
    <div className="space-y-2">
      {block.groups.map((g) => (
        <div key={g.course} role="group" aria-labelledby={`${baseId}-${g.course}`} className="rounded-2xl border border-line bg-paper px-4 py-1.5">
          <h3 id={`${baseId}-${g.course}`} className="flex items-center gap-2 pt-2 font-display text-[18px] text-ink">
            <MenuBookIcon className="h-5 w-5 text-neem" />
            {g.label}
          </h3>
          <ul className="divide-y divide-line">
            {g.items.map((i) => (
              <DishRow key={i.id} item={i} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function BlockView({ block, h }: { block: Block; h: BlockHandlers }) {
  switch (block.type) {
    case "quick_replies":
      return <Chips chips={block.chips} h={h} label="Suggestions" />;
    case "field_request":
      return block.field === "branch" && h.branchCards?.length ? <BranchCards chips={block.chips} h={h} label={block.prompt} /> : <Chips chips={block.chips} h={h} label={block.prompt} />;
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
    case "recommendation":
      return <Recommendation block={block} />;
    case "menu_list":
      return <MenuList block={block} />;
    case "confirm":
      return null; // rendered by ChatPanel, which owns the submit state
  }
}
