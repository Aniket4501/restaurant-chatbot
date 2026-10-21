"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ChevronIcon } from "@/components/ui/icons";
import { api, btn, ConfirmDialog, describe, ErrorBox, Field, inputCls, Loading, Notice, PageHeader, Pill, plural, useApi, panel, type Tone } from "@/components/admin/ui";
import { shortBranch } from "@/components/admin/labels";

// Availability (D-25): the hours, special dates, slot blocks and tables the booking engine reads, with a day view the
// engine computes itself, so what staff see is exactly what the chatbot offers guests. Capacity is table by table.

type Win = { opens: string; closes: string };
type Conflict = { ref: string; dateLabel: string; timeLabel: string; reason: string };
type Day = {
  branch: { slug: string; name: string; shortName: string; isActive: boolean };
  date: string;
  dateLabel: string;
  today: string;
  partySize: number;
  bookable: { ok: boolean; reason: string | null };
  hours: { source: "weekly" | "special"; windows: { service: string; label: string }[]; note: string | null };
  starts: { time: string; label: string; service: string; status: "open" | "lead_time" | "blocked" | "full"; freeTables: number; fittingTables: number; startingHere: number; blockReason: string | null }[];
  tables: { id: number; label: string; minSeats: number; maxSeats: number; isActive: boolean; bookings: { ref: string; guestName: string; partySize: number; startLabel: string; endLabel: string }[] }[];
  summary: { bookings: number; covers: number; open: number; blocked: number; full: number };
};
type Config = {
  weekly: { weekday: number; label: string; lunch: Win | null; dinner: Win | null }[];
  specialDates: { date: string; label: string; closedAllDay: boolean; lunch: Win | null; dinner: Win | null; note: string | null; inBookingWindow: boolean }[];
  blocks: { date: string; dateLabel: string; time: string; label: string; reason: string | null }[];
  tables: { id: number; label: string; minSeats: number; maxSeats: number; isActive: boolean; upcomingBookings: number }[];
  rules: { slotMinutes: number; sittingSmall: number; sittingLarge: number; largePartyFrom: number; leadMinutes: number; horizonDays: number; partyMin: number; partyMax: number; timezone: string };
};
type Branches = { branches: { slug: string; name: string; isActive: boolean }[] };

const STATUS: Record<Day["starts"][number]["status"], { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "good" },
  full: { label: "Full", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
  lead_time: { label: "Too soon", tone: "neutral" },
};

function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const TABS = [
  { key: "day", label: "Day view" },
  { key: "weekly", label: "Weekly hours" },
  { key: "special", label: "Special dates" },
  { key: "tables", label: "Tables" },
  { key: "rules", label: "Booking rules" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function AvailabilityPage({ today }: { today: string }) {
  const branches = useApi<Branches>("/api/admin/branches");
  const active = (branches.data?.branches ?? []).filter((b) => b.isActive);
  const [branch, setBranch] = useState<string | null>(null);
  const slug = branch ?? active[0]?.slug ?? null;
  const [tab, setTab] = useState<TabKey>("day");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const config = useApi<Config>(slug ? `/api/admin/branches/${slug}/availability` : null);

  const onTabKey = (e: KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    setTab(TABS[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-8">
      <PageHeader title="Availability" description="When guests can book, and the tables that seat them. The chatbot and the booking form use these settings straight away." />
      {branches.error && <ErrorBox message={`Couldn't load the branches. ${branches.error}`} onRetry={branches.reload} />}
      {!branches.data && !branches.error && <Loading label="Loading" rows={2} />}
      {slug && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="av-branch" className="text-[15px] text-muted">
              Branch
            </label>
            <select id="av-branch" value={slug} onChange={(e) => setBranch(e.target.value)} className="min-h-11 rounded-full border border-line bg-paper px-4 text-[15px]">
              {active.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {shortBranch(b.name)}
                </option>
              ))}
            </select>
          </div>
          <div role="tablist" aria-label="Availability settings" className="flex flex-wrap gap-1 border-b border-line">
            {TABS.map((t, i) => (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                role="tab"
                id={`tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls={`panel-${t.key}`}
                tabIndex={tab === t.key ? 0 : -1}
                onClick={() => setTab(t.key)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={`-mb-px min-h-11 border-b-2 px-4 text-[15px] ${tab === t.key ? "border-neem font-medium text-neem" : "border-transparent text-muted hover:text-ink"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === "day" && <DayView key={slug} slug={slug} today={today} onChanged={config.reload} />}
            {tab !== "day" && config.error && <ErrorBox message={config.error} onRetry={config.reload} />}
            {tab !== "day" && !config.data && !config.error && <Loading label="Loading the settings" rows={3} />}
            {tab === "weekly" && config.data && <WeeklyHours key={slug} slug={slug} weekly={config.data.weekly} onSaved={config.reload} />}
            {tab === "special" && config.data && <SpecialDates key={slug} slug={slug} today={today} dates={config.data.specialDates} blocks={config.data.blocks} onSaved={config.reload} />}
            {tab === "tables" && config.data && <Tables key={slug} slug={slug} tables={config.data.tables} onSaved={config.reload} />}
            {tab === "rules" && config.data && <Rules rules={config.data.rules} />}
          </div>
        </>
      )}
    </main>
  );
}

function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[14px]">
      {conflicts.map((c) => (
        <li key={c.ref}>
          {c.ref}, {c.dateLabel} at {c.timeLabel}: {c.reason}
        </li>
      ))}
    </ul>
  );
}

// ---------- day view ----------

function DayView({ slug, today, onChanged }: { slug: string; today: string; onChanged: () => void }) {
  const [date, setDate] = useState(today);
  const [party, setParty] = useState(2);
  const { data, error, reload } = useApi<Day>(`/api/admin/availability?branch=${slug}&date=${date}&party=${party}`);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "bad" | "warn"; text: string } | null>(null);

  const go = (d: string) => {
    setSelected([]);
    setMessage(null);
    setDate(d);
  };
  const toggle = (t: string) => setSelected((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  const selectedBlocked = data ? selected.filter((t) => data.starts.find((s) => s.time === t)?.status === "blocked") : [];
  const selectedOpen = selected.filter((t) => !selectedBlocked.includes(t));

  const act = async (kind: "block" | "reopen") => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const times = kind === "block" ? selectedOpen : selectedBlocked;
    const r = await api<{ added?: string[]; already?: string[]; bookingsAtTimes?: number; removed?: string[] }>(`/api/admin/branches/${slug}/blocks/${date}`, { method: kind === "block" ? "POST" : "DELETE", body: kind === "block" ? { times, reason: reason || null } : { times } });
    setBusy(false);
    if (!r.ok) {
      setMessage({ tone: "bad", text: r.error.message });
      return;
    }
    if (kind === "block") {
      const n = r.data.added?.length ?? 0;
      const kept = r.data.bookingsAtTimes ?? 0;
      setMessage({ tone: kept ? "warn" : "good", text: `Blocked ${plural(n, "time")}. Guests can't book ${n === 1 ? "it" : "them"} any more.${kept ? ` ${plural(kept, "booking")} already at ${n === 1 ? "that time" : "those times"} stay${kept === 1 ? "s" : ""} booked.` : ""}` });
    } else setMessage({ tone: "good", text: `Reopened ${plural(r.data.removed?.length ?? 0, "time")}.` });
    setSelected([]);
    setReason("");
    await reload();
    onChanged();
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-paper p-2 sm:flex-row sm:items-center">
        <div role="group" aria-label="Date" className="flex items-center gap-2">
          <button type="button" className={btn.icon} onClick={() => go(shift(date, -1))} aria-label="Previous day">
            <ChevronIcon dir="left" className="h-5 w-5" />
          </button>
          <label htmlFor="av-date" className="sr-only">
            Date
          </label>
          <input id="av-date" type="date" value={date} onChange={(e) => e.target.value && go(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-ash px-3 text-[15px] sm:flex-none" />
          <button type="button" className={btn.icon} onClick={() => go(shift(date, 1))} aria-label="Next day">
            <ChevronIcon dir="right" className="h-5 w-5" />
          </button>
          <button type="button" className={btn.secondary} onClick={() => go(today)} disabled={date === today}>
            Today
          </button>
        </div>
        <label htmlFor="av-party" className="flex items-center gap-2 text-[15px] sm:ml-auto">
          <span className="text-muted">Party of</span>
          <select id="av-party" value={party} onChange={(e) => (setSelected([]), setParty(Number(e.target.value)))} className="min-h-11 rounded-full border border-line bg-ash px-4 text-[15px]">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {!data && !error && <Loading label="Loading the day" rows={3} />}
      {data && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="font-display text-2xl">
              {data.branch.shortName}, {data.dateLabel}
            </h2>
            <p className="text-[15px] text-muted">
              {plural(data.summary.bookings, "booking")}, {plural(data.summary.covers, "guest")} · {data.summary.open} open, {data.summary.full} full, {data.summary.blocked} blocked for a party of {data.partySize}
            </p>
          </div>
          <p className="text-[15px]">
            {data.hours.windows.length ? (
              <>
                {data.hours.source === "special" ? "Special hours" : "Weekly hours"}: {data.hours.windows.map((w) => `${w.service === "lunch" ? "lunch" : "dinner"} ${w.label}`).join(", ")}
                {data.hours.note ? ` (${data.hours.note})` : ""}
              </>
            ) : (
              <>Closed{data.hours.note ? ` (${data.hours.note})` : ""}.</>
            )}
          </p>
          {!data.bookable.ok && <Notice tone="warn">{data.bookable.reason} Times are shown as the engine would see them.</Notice>}
          {message && <Notice tone={message.tone}>{message.text}</Notice>}

          {data.starts.length > 0 && (
            <section aria-labelledby="starts-h" className={`${panel} p-4`}>
              <h3 id="starts-h" className="text-[15px] font-medium">
                Start times
              </h3>
              <p className="text-[13px] text-muted">Tick times to block or reopen them. &quot;Full&quot; means no free table seats {plural(data.partySize, "guest")} for the whole sitting.</p>
              <fieldset className="mt-3">
                <legend className="sr-only">Start times on {data.dateLabel}</legend>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {data.starts.map((s) => {
                    const disabled = s.status === "lead_time";
                    const st = STATUS[s.status];
                    return (
                      <label key={s.time} className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 py-2 ${selected.includes(s.time) ? "border-neem bg-neem-tint" : "border-line"} ${disabled ? "opacity-60" : "cursor-pointer"}`}>
                        <input type="checkbox" checked={selected.includes(s.time)} disabled={disabled} onChange={() => toggle(s.time)} aria-label={`${s.label}, ${st.label}${s.status === "blocked" && s.blockReason ? ` (${s.blockReason})` : ""}, ${s.freeTables} of ${s.fittingTables} fitting tables free`} />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium tabular-nums">{s.label}</span>
                          <span className="block text-[13px] text-muted">
                            {s.freeTables} of {s.fittingTables} tables free{s.startingHere ? ` · ${plural(s.startingHere, "booking")} start` : ""}
                            {s.status === "blocked" && s.blockReason ? ` · ${s.blockReason}` : ""}
                          </span>
                        </span>
                        <Pill tone={st.tone}>{st.label}</Pill>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              {selected.length > 0 && (
                <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-end">
                  {selectedOpen.length > 0 && (
                    <Field id="blk-reason" label="Reason (optional, staff only)">
                      <input id="blk-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} placeholder="Private event, staff training…" />
                    </Field>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {selectedOpen.length > 0 && (
                      <button type="button" className={btn.primary} onClick={() => act("block")} disabled={busy}>
                        {busy ? "Saving…" : `Block ${plural(selectedOpen.length, "time")}`}
                      </button>
                    )}
                    {selectedBlocked.length > 0 && (
                      <button type="button" className={btn.secondary} onClick={() => act("reopen")} disabled={busy}>
                        {busy ? "Saving…" : `Reopen ${plural(selectedBlocked.length, "time")}`}
                      </button>
                    )}
                    <button type="button" className={btn.secondary} onClick={() => setSelected([])} disabled={busy}>
                      Clear
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          <section aria-labelledby="tables-h" className={`${panel} p-4`}>
            <h3 id="tables-h" className="text-[15px] font-medium">
              Tables and their bookings
            </h3>
            <ul className="mt-2 divide-y divide-line">
              {data.tables.map((t) => (
                <li key={t.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2 text-[15px]">
                  <span className="w-28 shrink-0">
                    <span className="font-medium">{t.label}</span>{" "}
                    <span className="text-[13px] text-muted">
                      {t.minSeats}–{t.maxSeats} guests
                    </span>
                    {!t.isActive && (
                      <span className="block">
                        <Pill tone="neutral">Inactive</Pill>
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 text-[14px]">
                    {t.bookings.length ? t.bookings.map((b) => <span key={b.ref} className="mr-3 inline-block">{b.startLabel}–{b.endLabel}, {b.guestName}, {plural(b.partySize, "guest")} ({b.ref})</span>) : <span className="text-muted">No bookings</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

// ---------- weekly hours ----------

type DayForm = { weekday: number; label: string; lunch: Win | null; dinner: Win | null };

function WindowInputs({ id, label, value, onChange }: { id: string; label: string; value: Win | null; onChange: (w: Win | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex min-h-11 items-center gap-2 text-[14px]">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? { opens: label === "Lunch" ? "12:00" : "19:00", closes: label === "Lunch" ? "15:30" : "23:00" } : null)} aria-label={`${id}: open for ${label.toLowerCase()}`} />
        {label}
      </label>
      {value ? (
        <>
          <input type="time" step={1800} value={value.opens} onChange={(e) => onChange({ ...value, opens: e.target.value })} aria-label={`${id} ${label.toLowerCase()} opens`} className="min-h-11 rounded-xl border border-line bg-paper px-2 text-[15px]" />
          <span aria-hidden="true">to</span>
          <input type="time" step={1800} value={value.closes === "24:00" ? "23:59" : value.closes} onChange={(e) => onChange({ ...value, closes: e.target.value })} aria-label={`${id} ${label.toLowerCase()} closes`} className="min-h-11 rounded-xl border border-line bg-paper px-2 text-[15px]" />
        </>
      ) : (
        <span className="text-[14px] text-muted">Closed</span>
      )}
    </div>
  );
}

function WeeklyHours({ slug, weekly, onSaved }: { slug: string; weekly: DayForm[]; onSaved: () => void }) {
  const [days, setDays] = useState<DayForm[]>(weekly);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "bad" | "warn"; text: string } | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const changed = JSON.stringify(days) !== JSON.stringify(weekly);

  const save = async (confirm = false) => {
    setBusy(true);
    setMessage(null);
    const r = await api<{ summary: string; accepted: Conflict[] }>(`/api/admin/branches/${slug}/hours`, { method: "PUT", body: { days: days.map(({ weekday, lunch, dinner }) => ({ weekday, lunch, dinner })), ...(confirm ? { confirm: true } : {}) } });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409 && Array.isArray(r.error.conflicts)) {
        setConflicts(r.error.conflicts as Conflict[]);
        return;
      }
      setMessage({ tone: "bad", text: r.error.message });
      return;
    }
    setConflicts(null);
    setMessage({ tone: r.data.accepted.length ? "warn" : "good", text: r.data.summary === "no change" ? "Nothing to save: no changes." : `Saved. ${r.data.accepted.length ? `${plural(r.data.accepted.length, "booking")} now fall outside the hours; they stay booked, so contact the guests.` : "The chatbot and the booking form use the new hours now."}` });
    onSaved();
  };

  return (
    <form
      className={`${panel} mt-4 space-y-3 p-4`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save();
      }}
      aria-label="Weekly hours"
    >
      <p className="text-[14px] text-muted">Each service needs at least 1 h 30 min (the shortest sitting); lunch and dinner can&apos;t overlap. Special dates override these.</p>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <ul className="divide-y divide-line">
        {days.map((d, i) => (
          <li key={d.weekday} className="grid gap-2 py-2 md:grid-cols-[8rem_1fr_1fr] md:items-center">
            <span className="font-medium">{d.label}</span>
            <WindowInputs id={d.label} label="Lunch" value={d.lunch} onChange={(w) => setDays(days.map((x, j) => (j === i ? { ...x, lunch: w } : x)))} />
            <WindowInputs id={d.label} label="Dinner" value={d.dinner} onChange={(w) => setDays(days.map((x, j) => (j === i ? { ...x, dinner: w } : x)))} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={() => (setDays(weekly), setMessage(null))} disabled={!changed || busy}>
          Undo changes
        </button>
        <button type="submit" className={btn.primary} disabled={!changed || busy}>
          {busy ? "Saving…" : "Save weekly hours"}
        </button>
      </div>
      <ConfirmDialog
        open={!!conflicts}
        title="Some bookings wouldn't fit"
        tone="primary"
        body={
          <>
            <p>These confirmed bookings would fall outside the new hours. They stay booked either way; you&apos;d need to contact the guests.</p>
            <ConflictList conflicts={conflicts ?? []} />
          </>
        }
        confirmLabel="Save anyway"
        busyLabel="Saving…"
        cancelLabel="Don't save"
        busy={busy}
        onConfirm={() => save(true)}
        onCancel={() => setConflicts(null)}
      />
    </form>
  );
}

// ---------- special dates ----------

function SpecialDates({ slug, today, dates, blocks, onSaved }: { slug: string; today: string; dates: Config["specialDates"]; blocks: Config["blocks"]; onSaved: () => void }) {
  const [date, setDate] = useState(shift(today, 1));
  const [closedAllDay, setClosedAllDay] = useState(true);
  const [lunch, setLunch] = useState<Win | null>({ opens: "12:00", closes: "15:30" });
  const [dinner, setDinner] = useState<Win | null>({ opens: "19:00", closes: "23:00" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "bad" | "warn"; text: string } | null>(null);
  const [conflicts, setConflicts] = useState<{ list: Conflict[]; retry: () => void } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const edit = (d: Config["specialDates"][number]) => {
    setDate(d.date);
    setClosedAllDay(d.closedAllDay);
    setLunch(d.lunch);
    setDinner(d.dinner);
    setNote(d.note ?? "");
    setMessage(null);
  };

  const save = async (confirm = false) => {
    setBusy(true);
    setMessage(null);
    const r = await api<{ accepted: Conflict[] }>(`/api/admin/branches/${slug}/special-dates/${date}`, { method: "PUT", body: { closedAllDay, lunch: closedAllDay ? null : lunch, dinner: closedAllDay ? null : dinner, note: note || null, ...(confirm ? { confirm: true } : {}) } });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409 && Array.isArray(r.error.conflicts)) return setConflicts({ list: r.error.conflicts as Conflict[], retry: () => save(true) });
      return setMessage({ tone: "bad", text: r.error.fields ? Object.values(r.error.fields).join(" ") : r.error.message });
    }
    setConflicts(null);
    setMessage({ tone: r.data.accepted.length ? "warn" : "good", text: `Saved the hours for ${date}.${r.data.accepted.length ? ` ${plural(r.data.accepted.length, "booking")} now fall outside them and stay booked; contact the guests.` : ""}` });
    onSaved();
  };

  const remove = async (d: string, confirm = false) => {
    setBusy(true);
    const r = await api<{ accepted: Conflict[] }>(`/api/admin/branches/${slug}/special-dates/${d}${confirm ? "?confirm=1" : ""}`, { method: "DELETE" });
    setBusy(false);
    setRemoving(null);
    if (!r.ok) {
      if (r.status === 409 && Array.isArray(r.error.conflicts)) return setConflicts({ list: r.error.conflicts as Conflict[], retry: () => remove(d, true) });
      return setMessage({ tone: "bad", text: r.error.message });
    }
    setConflicts(null);
    setMessage({ tone: "good", text: `${d} is back to the weekly hours.` });
    onSaved();
  };

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.1fr]">
      <form
        className={`${panel} space-y-3 p-4`}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save();
        }}
        aria-label="Set a special date"
      >
        <h2 className="font-display text-xl">Set special hours or a closure</h2>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <Field id="sp-date" label="Date">
          <input {...describe("sp-date")} type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-[15px]">
          <input type="checkbox" checked={closedAllDay} onChange={(e) => setClosedAllDay(e.target.checked)} />
          Closed all day
        </label>
        {!closedAllDay && (
          <div className="space-y-1">
            <WindowInputs id={date} label="Lunch" value={lunch} onChange={setLunch} />
            <WindowInputs id={date} label="Dinner" value={dinner} onChange={setDinner} />
            <p className="text-[13px] text-muted">A special date replaces that day&apos;s weekly hours entirely, so set both services.</p>
          </div>
        )}
        <Field id="sp-note" label="Note (guests see it in the chatbot's hours answers)">
          <input {...describe("sp-note")} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Closed for a private event" />
        </Field>
        <div className="flex justify-end">
          <button type="submit" className={btn.primary} disabled={busy || !date}>
            {busy ? "Saving…" : "Save special date"}
          </button>
        </div>
      </form>
      <section aria-labelledby="sp-list-h" className="space-y-3">
        <h2 id="sp-list-h" className="font-display text-xl">
          Upcoming special dates
        </h2>
        {dates.length === 0 ? (
          <p className="text-[15px] text-muted">None. The weekly hours apply every day.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-paper">
            {dates.map((d) => (
              <li key={d.date} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[15px]">
                <span>
                  <span className="font-medium">{d.label}</span>
                  <span className="block text-[14px] text-muted">
                    {d.closedAllDay ? "Closed all day" : `Lunch ${d.lunch ? `${d.lunch.opens}–${d.lunch.closes}` : "closed"}, dinner ${d.dinner ? `${d.dinner.opens}–${d.dinner.closes}` : "closed"}`}
                    {d.note ? ` · ${d.note}` : ""}
                    {!d.inBookingWindow ? " · beyond the booking window" : ""}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button type="button" className={btn.secondary} onClick={() => edit(d)}>
                    Edit
                  </button>
                  <button type="button" className={btn.secondary} onClick={() => setRemoving(d.date)} aria-label={`Remove the special hours on ${d.label}`}>
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <h2 className="font-display text-xl">Blocked start times</h2>
        {blocks.length === 0 ? (
          <p className="text-[15px] text-muted">None. Block times from the day view.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-paper text-[15px]">
            {blocks.map((b) => (
              <li key={b.date + b.time} className="px-4 py-2">
                {b.dateLabel}, {b.label}
                {b.reason ? <span className="text-muted"> · {b.reason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog open={!!removing} title="Remove these special hours?" tone="primary" body={<p>{removing} goes back to the weekly hours.</p>} confirmLabel="Remove" busyLabel="Removing…" cancelLabel="Keep them" busy={busy} onConfirm={() => removing && remove(removing)} onCancel={() => setRemoving(null)} />
      <ConfirmDialog
        open={!!conflicts}
        title="Some bookings wouldn't fit"
        tone="primary"
        body={
          <>
            <p>These confirmed bookings would fall outside the hours. They stay booked either way; contact the guests.</p>
            <ConflictList conflicts={conflicts?.list ?? []} />
          </>
        }
        confirmLabel="Save anyway"
        busyLabel="Saving…"
        cancelLabel="Don't save"
        busy={busy}
        onConfirm={() => conflicts?.retry()}
        onCancel={() => setConflicts(null)}
      />
    </div>
  );
}

// ---------- tables ----------

function Tables({ slug, tables, onSaved }: { slug: string; tables: Config["tables"]; onSaved: () => void }) {
  const [label, setLabel] = useState("");
  const [min, setMin] = useState("2");
  const [max, setMax] = useState("4");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "bad" | "warn"; text: string } | null>(null);
  const [seats, setSeats] = useState<Record<number, { min: string; max: string }>>({});
  const [conflicts, setConflicts] = useState<{ list: Conflict[]; retry: () => void } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSeats(Object.fromEntries(tables.map((x) => [x.id, { min: String(x.minSeats), max: String(x.maxSeats) }]))), 0);
    return () => clearTimeout(t);
  }, [tables]);

  const patch = async (id: number, body: Record<string, unknown>, what: string) => {
    setBusy(true);
    setMessage(null);
    const r = await api<{ accepted: Conflict[] }>(`/api/admin/branches/${slug}/tables/${id}`, { method: "PATCH", body });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409 && Array.isArray(r.error.conflicts)) return setConflicts({ list: r.error.conflicts as Conflict[], retry: () => patch(id, { ...body, confirm: true }, what) });
      return setMessage({ tone: "bad", text: r.error.fields ? Object.values(r.error.fields).join(" ") : r.error.message });
    }
    setConflicts(null);
    setMessage({ tone: r.data.accepted.length ? "warn" : "good", text: `${what}.${r.data.accepted.length ? ` ${plural(r.data.accepted.length, "booking")} on it stay booked; check them.` : ""}` });
    onSaved();
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const r = await api(`/api/admin/branches/${slug}/tables`, { body: { label, minSeats: Number(min), maxSeats: Number(max) } });
    setBusy(false);
    if (!r.ok) {
      setFields(r.error.fields ?? {});
      return setMessage({ tone: "bad", text: r.error.message });
    }
    setFields({});
    setMessage({ tone: "good", text: `Added table ${label}. Guests can book it now.` });
    setLabel("");
    onSaved();
  };

  return (
    <div className="mt-4 space-y-4">
      <p className="text-[14px] text-muted">A booking holds one table for its sitting. A party is seated at the smallest free table whose seats fit it. Tables with bookings are deactivated, never deleted.</p>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="overflow-hidden rounded-xl border border-line bg-paper">
        <table className="w-full text-left text-[15px]">
          <thead className="border-b border-line bg-ash/60 text-[14px] text-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Table</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Guests</th>
              <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">Upcoming bookings</th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => {
              const s = seats[t.id] ?? { min: String(t.minSeats), max: String(t.maxSeats) };
              const dirty = s.min !== String(t.minSeats) || s.max !== String(t.maxSeats);
              return (
                <tr key={t.id} className={`border-b border-line last:border-0 ${t.isActive ? "" : "text-muted"}`}>
                  <td className="px-4 py-2.5 font-medium">
                    {t.label} {!t.isActive && <Pill tone="neutral">Inactive</Pill>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5">
                      <input aria-label={`Table ${t.label}: fewest guests`} inputMode="numeric" value={s.min} onChange={(e) => setSeats({ ...seats, [t.id]: { ...s, min: e.target.value.replace(/\D/g, "") } })} className="min-h-11 w-14 rounded-xl border border-line bg-paper px-2 text-center" />
                      <span aria-hidden="true">to</span>
                      <input aria-label={`Table ${t.label}: most guests`} inputMode="numeric" value={s.max} onChange={(e) => setSeats({ ...seats, [t.id]: { ...s, max: e.target.value.replace(/\D/g, "") } })} className="min-h-11 w-14 rounded-xl border border-line bg-paper px-2 text-center" />
                      {dirty && (
                        <button type="button" className={btn.secondary} disabled={busy} onClick={() => patch(t.id, { minSeats: Number(s.min), maxSeats: Number(s.max) }, `Table ${t.label} now seats ${s.min}–${s.max}`)}>
                          Save
                        </button>
                      )}
                    </span>
                  </td>
                  <td className="hidden px-4 py-2.5 tabular-nums sm:table-cell">{t.upcomingBookings}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button type="button" className={btn.secondary} disabled={busy} onClick={() => patch(t.id, { isActive: !t.isActive }, t.isActive ? `Table ${t.label} deactivated` : `Table ${t.label} activated`)}>
                      {t.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form onSubmit={add} noValidate className={`${panel} grid gap-3 p-4 sm:grid-cols-[1fr_7rem_7rem_auto] sm:items-end`} aria-label="Add a table">
        <Field id="t-label" label="New table label" error={fields.label}>
          <input {...describe("t-label", fields.label)} className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={12} placeholder="T7" />
        </Field>
        <Field id="t-min" label="Fewest guests" error={fields.minSeats}>
          <input {...describe("t-min", fields.minSeats)} className={inputCls} inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field id="t-max" label="Most guests" error={fields.maxSeats}>
          <input {...describe("t-max", fields.maxSeats)} className={inputCls} inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <button type="submit" className={btn.primary} disabled={busy || !label.trim()}>
          Add table
        </button>
      </form>
      <ConfirmDialog
        open={!!conflicts}
        title="Bookings on this table"
        tone="primary"
        body={
          <>
            <p>These confirmed bookings would no longer have a fitting active table. They stay booked; you&apos;d need to seat them yourselves.</p>
            <ConflictList conflicts={conflicts?.list ?? []} />
          </>
        }
        confirmLabel="Save anyway"
        busyLabel="Saving…"
        cancelLabel="Don't save"
        busy={busy}
        onConfirm={() => conflicts?.retry()}
        onCancel={() => setConflicts(null)}
      />
    </div>
  );
}

function Rules({ rules }: { rules: Config["rules"] }) {
  return (
    <section className={`${panel} mt-4 space-y-2 p-4 text-[15px]`} aria-label="Booking rules">
      <p className="text-[14px] text-muted">These rules are fixed in the application (lib/config.ts) and apply to every branch. Changing them needs a code change, because the chatbot&apos;s answers and the FAQs quote them.</p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[16rem_1fr]">
        <dt className="text-muted">Start times</dt>
        <dd>Every {rules.slotMinutes} minutes from each service&apos;s opening time</dd>
        <dt className="text-muted">Sitting</dt>
        <dd>
          {rules.sittingSmall} minutes for up to {rules.largePartyFrom - 1} guests, {rules.sittingLarge} minutes for {rules.largePartyFrom} or more
        </dd>
        <dt className="text-muted">Book at least</dt>
        <dd>{rules.leadMinutes} minutes ahead</dd>
        <dt className="text-muted">Book up to</dt>
        <dd>{rules.horizonDays} days ahead</dd>
        <dt className="text-muted">Online party size</dt>
        <dd>
          {rules.partyMin} to {rules.partyMax} guests (larger groups are asked to call)
        </dd>
        <dt className="text-muted">Time zone</dt>
        <dd>{rules.timezone}</dd>
      </dl>
    </section>
  );
}
