"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronIcon, SearchIcon } from "@/components/ui/icons";
import { api, btn, ConfirmDialog, Modal, Notice, Pill } from "@/components/admin/ui";

// Staff bookings view (§5.10, AC-07, J10, BR-13; D-25). Data loads client-side through the admin API (D-16): a date
// navigator starting on the server's today, branch and status filters, a name/reference search across all dates,
// totals for the day and branch, a time-sorted table with status pills, booking details on request (the full mobile
// number, email and note are shown only there), an in-app cancel dialog (never window.confirm), skeleton, empty and
// error states, and a 30-second refresh.

type Item = {
  ref: string;
  status: "confirmed" | "cancelled";
  branch: { slug: string; name: string };
  date: string;
  dateLabel: string;
  timeLabel: string;
  partySize: number;
  guestName: string;
  phoneMasked: string;
  hasNote: boolean;
};
type List = { mode: "day" | "search"; date: string; q: string | null; items: Item[]; totals: { confirmed: number; covers: number; cancelled: number }; truncated: boolean };
type Detail = Item & { branchShortName: string; endLabel: string; sittingMinutes: number; phoneLabel: string; email: string | null; note: string | null; table: string; source: string; createdLabel: string; cancelledLabel: string | null };
type Props = { today: string; branches: { slug: string; name: string }[]; zone: string };

const REFRESH_MS = 30_000;

/** "2026-10-17" ± days, as pure date arithmetic (no clock). */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

function longLabel(date: string, zone: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: zone }).format(new Date(Date.UTC(y, m - 1, d, 6, 30)));
}

const short = (name: string) => name.split(", ").pop()!;
const guests = (n: number) => `${n} ${n === 1 ? "guest" : "guests"}`;

export function AdminDashboard({ today, branches, zone }: Props) {
  const [date, setDate] = useState(today);
  const [branch, setBranch] = useState("all");
  const [status, setStatus] = useState<"all" | "confirmed" | "cancelled">("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Item | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    const qs = new URLSearchParams({ date, branch, status, ...(search ? { q: search } : {}) });
    const r = await api<List>(`/api/admin/reservations?${qs}`);
    if (id !== request.current) return;
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError("Couldn't load bookings.");
  }, [date, branch, status, search]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  // Search as staff type, after a short pause; one character is too broad to be useful.
  useEffect(() => {
    const t = setTimeout(() => {
      const q = query.trim();
      setSearch(q.length >= 2 ? q : "");
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const go = (d: string) => {
    setData(null);
    setDate(d);
  };

  const openDetail = async (item: Item) => {
    setDetailError(null);
    const r = await api<Detail>(`/api/admin/reservations/${item.ref}`);
    if (r.ok) setDetail(r.data);
    else setDetailError(`Couldn't load ${item.ref}: ${r.error.message}`);
  };

  const openCancel = (item: Item) => {
    setCancelError(null);
    setDetail(null);
    setCancelling(item);
  };

  const confirmCancel = async () => {
    if (!cancelling || busy) return;
    setBusy(true);
    const r = await api<{ changed: boolean }>(`/api/admin/reservations/${cancelling.ref}`, { method: "PATCH", body: { status: "cancelled" } });
    setBusy(false);
    if (!r.ok) {
      // A refused request changed nothing; a lost connection or a server error leaves the outcome unknown, so the list is
      // reloaded to show what was saved (failure-mode audit FM-039).
      const unknown = r.status === 0 || r.status >= 500;
      setCancelError(r.status === 404 ? "This booking no longer exists." : unknown ? "We couldn't confirm whether this booking was cancelled. The list has been reloaded: check its status." : `Couldn't cancel this booking: ${r.error.message}`);
      if (unknown) await load();
      return;
    }
    setNotice(r.data.changed ? `Cancelled ${cancelling.ref}. The table is free for other guests now.` : `${cancelling.ref} was already cancelled.`);
    setCancelling(null);
    await load();
  };

  const searching = data?.mode === "search";
  const iconButton = btn.icon;

  return (
    <main>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8">
        <h1 className="font-display text-3xl sm:text-4xl">Bookings</h1>

        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-line bg-paper p-2 lg:flex-row lg:flex-wrap lg:items-center">
          <div role="group" aria-label="Date" className="flex items-center gap-2">
            <button type="button" className={iconButton} onClick={() => go(shift(date, -1))} aria-label="Previous day" disabled={searching}>
              <ChevronIcon dir="left" className="h-5 w-5" />
            </button>
            <label className="sr-only" htmlFor="admin-date">
              Date
            </label>
            <input id="admin-date" type="date" value={date} onChange={(e) => e.target.value && go(e.target.value)} disabled={searching} className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-ash px-3 text-[15px] sm:flex-none sm:px-4" />
            <button type="button" className={iconButton} onClick={() => go(shift(date, 1))} aria-label="Next day" disabled={searching}>
              <ChevronIcon dir="right" className="h-5 w-5" />
            </button>
            <button type="button" className={`${btn.secondary} shrink-0 px-3 sm:px-4`} onClick={() => go(today)} disabled={date === today || searching}>
              Today
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <label className="flex flex-1 items-center gap-2 text-[15px]" htmlFor="admin-branch">
              <span className="text-muted">Branch</span>
              <select
                id="admin-branch"
                value={branch}
                onChange={(e) => {
                  setData(null);
                  setBranch(e.target.value);
                }}
                className="min-h-11 flex-1 rounded-full border border-line bg-ash px-4 text-[15px] sm:flex-none"
              >
                <option value="all">All branches</option>
                {branches.map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {short(b.name)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 items-center gap-2 text-[15px]" htmlFor="admin-status">
              <span className="text-muted">Status</span>
              <select id="admin-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="min-h-11 flex-1 rounded-full border border-line bg-ash px-4 text-[15px] sm:flex-none">
                <option value="all">All</option>
                <option value="confirmed">Confirmed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
          <div className="relative w-full lg:w-72">
            <label htmlFor="admin-search" className="sr-only">
              Search by guest name or reference
            </label>
            <SearchIcon className="pointer-events-none absolute top-3 left-3 h-5 w-5 text-muted" />
            <input id="admin-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Guest name or NE- reference" className="min-h-11 w-full rounded-full border border-line bg-ash pr-4 pl-10 text-[15px]" />
          </div>
        </div>

        {notice && (
          <div className="mt-4">
            <Notice tone="good">{notice}</Notice>
          </div>
        )}
        {detailError && (
          <div className="mt-4">
            <Notice tone="bad">{detailError}</Notice>
          </div>
        )}

        <section aria-labelledby="day-heading" className="mt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="day-heading" className="font-display text-2xl">
              {searching ? `Search results for “${data?.q}”` : longLabel(date, zone)}
            </h2>
            {data && (
              <p className="text-[15px] text-muted">
                <span data-testid="totals">
                  <span className="font-display text-2xl text-neem">{data.totals.confirmed}</span> {data.totals.confirmed === 1 ? "booking" : "bookings"},{" "}
                  <span className="font-display text-2xl text-neem">{data.totals.covers}</span> {data.totals.covers === 1 ? "guest" : "guests"}
                </span>
                {data.totals.cancelled > 0 && <span>, {data.totals.cancelled} cancelled</span>}
              </p>
            )}
          </div>
          {searching && <p className="mt-1 text-[14px] text-muted">Matching bookings on any date, upcoming first. Clear the search to go back to the day view.{data?.truncated ? " Showing the first 50 matches." : ""}</p>}

          {error && (
            <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-warn-tint px-4 py-3 text-warn">
              {error}
              <button type="button" className={btn.secondary} onClick={load}>
                Retry
              </button>
            </div>
          )}

          {!data && !error && (
            <div aria-busy="true" aria-label="Loading bookings" className="mt-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-paper" />
              ))}
            </div>
          )}

          {data && data.items.length === 0 && (
            <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-8 text-center text-[16px] text-muted">
              {searching ? "No bookings match that name or reference." : `No ${status === "all" ? "" : `${status} `}bookings for this day${branch !== "all" ? " at this branch" : ""}.`}
            </p>
          )}

          {data && data.items.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-xl border border-line bg-paper">
              <table className="w-full text-left text-[15px]">
                <thead className="border-b border-line bg-ash/60 text-[14px] text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">{searching ? "When" : "Time"}</th>
                    <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">Guest</th>
                    <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">Party</th>
                    <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">Branch</th>
                    <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">Status</th>
                    <th scope="col" className="hidden px-4 py-2.5 sm:table-cell">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.ref} className={`border-b border-line align-top last:border-0 ${i.status === "cancelled" ? "text-muted" : ""}`}>
                      <td className="px-3 py-3 whitespace-nowrap sm:px-4">
                        {searching && <span className="block text-sm text-muted">{i.dateLabel}</span>}
                        <span className="font-medium tabular-nums">{i.timeLabel}</span>
                        {/* On a phone, party and status sit under the time: four columns don't fit 390 px. */}
                        <span className="block text-sm text-muted sm:hidden">{guests(i.partySize)}</span>
                        <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-sm sm:hidden ${i.status === "confirmed" ? "bg-neem-tint text-neem-dark" : "bg-ash text-muted"}`}>{i.status === "confirmed" ? "Confirmed" : "Cancelled"}</span>
                      </td>
                      <td className="px-3 py-3 sm:px-4">
                        {i.guestName}
                        <span className="block text-sm whitespace-nowrap text-muted">{i.phoneMasked}</span>
                        <span className="block text-sm whitespace-nowrap text-muted">
                          {i.ref}
                          <span className="md:hidden"> · {short(i.branch.name)}</span>
                        </span>
                        {i.hasNote && <span className="block text-sm text-muted">Has a note</span>}
                        <span className="mt-1.5 flex flex-wrap gap-x-4 sm:hidden">
                          <button type="button" className="min-h-11 text-[15px] text-neem underline underline-offset-4" onClick={() => openDetail(i)} aria-label={`Details of ${i.guestName}'s booking at ${i.timeLabel}`}>
                            Details
                          </button>
                          {i.status === "confirmed" && (
                            <button type="button" className="min-h-11 text-[15px] text-warn underline underline-offset-4" onClick={() => openCancel(i)} aria-label={`Cancel ${i.guestName}'s booking at ${i.timeLabel}`}>
                              Cancel
                            </button>
                          )}
                        </span>
                      </td>
                      <td className="hidden px-4 py-3 tabular-nums sm:table-cell">{i.partySize}</td>
                      <td className="hidden px-4 py-3 md:table-cell">{short(i.branch.name)}</td>
                      <td className="hidden px-4 py-3 sm:table-cell">
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-sm whitespace-nowrap ${i.status === "confirmed" ? "bg-neem-tint text-neem-dark" : "bg-ash text-muted"}`}>{i.status === "confirmed" ? "Confirmed" : "Cancelled"}</span>
                      </td>
                      <td className="hidden px-4 py-2 text-right whitespace-nowrap sm:table-cell">
                        <span className="inline-flex gap-2">
                          <button type="button" className={btn.secondary} onClick={() => openDetail(i)} aria-label={`Details of ${i.guestName}'s booking at ${i.timeLabel}`}>
                            Details
                          </button>
                          {i.status === "confirmed" && (
                            <button type="button" className={btn.secondary} onClick={() => openCancel(i)} aria-label={`Cancel ${i.guestName}'s booking at ${i.timeLabel}`}>
                              Cancel
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Booking ${detail.ref}` : "Booking"}>
        {detail && (
          <div className="space-y-4 text-[15px]">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={detail.status === "confirmed" ? "good" : "neutral"}>{detail.status === "confirmed" ? "Confirmed" : "Cancelled"}</Pill>
              <span className="text-muted">Made through the {detail.source.toLowerCase()} on {detail.createdLabel}</span>
            </div>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2">
              <dt className="text-muted">Guest</dt>
              <dd>{detail.guestName}</dd>
              <dt className="text-muted">Mobile</dt>
              <dd>
                <a href={`tel:${detail.phoneLabel.replace(/\s/g, "")}`} className="text-neem underline underline-offset-4">
                  {detail.phoneLabel}
                </a>
              </dd>
              <dt className="text-muted">Email</dt>
              <dd>{detail.email ?? "Not given"}</dd>
              <dt className="text-muted">When</dt>
              <dd>
                {detail.dateLabel}, {detail.timeLabel} to {detail.endLabel} ({detail.sittingMinutes} minutes)
              </dd>
              <dt className="text-muted">Where</dt>
              <dd>
                {detail.branchShortName}, table {detail.table}
              </dd>
              <dt className="text-muted">Party</dt>
              <dd>{guests(detail.partySize)}</dd>
              <dt className="text-muted">Note</dt>
              <dd>{detail.note ?? "No note"}</dd>
              {detail.cancelledLabel && (
                <>
                  <dt className="text-muted">Cancelled</dt>
                  <dd>{detail.cancelledLabel}</dd>
                </>
              )}
            </dl>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btn.secondary} onClick={() => setDetail(null)}>
                Done
              </button>
              {detail.status === "confirmed" && (
                <button type="button" className="min-h-11 rounded-full bg-warn px-4 text-[15px] font-medium text-white hover:opacity-90" onClick={() => openCancel(detail)}>
                  Cancel this booking
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!cancelling}
        title="Cancel this booking?"
        body={cancelling && <p>{cancelling.guestName}, {guests(cancelling.partySize)} at {cancelling.timeLabel}{data?.mode === "search" ? ` on ${cancelling.dateLabel}` : ""}, {short(cancelling.branch.name)} ({cancelling.ref}). The table becomes free for other guests straight away.</p>}
        confirmLabel="Cancel booking"
        busyLabel="Cancelling…"
        cancelLabel="Keep booking"
        error={cancelError}
        busy={busy}
        onConfirm={confirmCancel}
        onCancel={() => !busy && setCancelling(null)}
      />
    </main>
  );
}
