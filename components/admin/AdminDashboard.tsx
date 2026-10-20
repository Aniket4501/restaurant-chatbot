"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { ChevronIcon } from "@/components/ui/icons";

// Staff bookings view (§5.10, AC-07, J10, BR-13). Data loads client-side through the admin API (D-16): a date
// navigator starting on the server's today, a branch filter, totals, a time-sorted table with status pills, an in-app
// cancel dialog (never window.confirm), skeleton, empty and error states, and a 30-second refresh.

type Item = {
  ref: string;
  status: "confirmed" | "cancelled";
  branch: { slug: string; name: string };
  timeLabel: string;
  partySize: number;
  guestName: string;
  phone: string;
  phoneLabel: string;
  email: string | null;
  note: string | null;
};
type List = { date: string; items: Item[]; totals: { confirmed: number; covers: number } };
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

export function AdminDashboard({ today, branches, zone }: Props) {
  const router = useRouter();
  const [date, setDate] = useState(today);
  const [branch, setBranch] = useState("all");
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Item | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const res = await fetch(`/api/admin/reservations?date=${date}&branch=${branch}&status=all`, { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/admin/login");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as List;
      if (id === request.current) {
        setData(j);
        setError(null);
      }
    } catch {
      if (id === request.current) setError("Couldn't load bookings.");
    }
  }, [date, branch, router]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  const go = (d: string) => {
    setData(null);
    setDate(d);
  };

  const openCancel = (item: Item) => {
    setCancelError(null);
    setCancelling(item);
    dialog.current?.showModal();
  };

  const confirmCancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/reservations/${cancelling.ref}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
      if (res.status === 401) return router.replace("/admin/login");
      if (!res.ok) throw new Error(String(res.status));
      dialog.current?.close();
      setCancelling(null);
      await load();
    } catch {
      setCancelError("Couldn't cancel this booking. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const button = "min-h-11 rounded-full border border-line bg-paper px-4 text-[15px] hover:border-neem hover:text-neem disabled:opacity-50";
  const iconButton = "flex h-11 w-11 items-center justify-center rounded-full border border-line bg-paper hover:border-neem hover:text-neem";

  return (
    <div className="min-h-dvh">
      <AdminHeader current="bookings" />

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8">
        <h1 className="font-display text-3xl sm:text-4xl">Bookings</h1>

        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-line bg-paper p-2 sm:flex-row sm:items-center">
          <div role="group" aria-label="Date" className="flex items-center gap-2">
            <button type="button" className={iconButton} onClick={() => go(shift(date, -1))} aria-label="Previous day">
              <ChevronIcon dir="left" className="h-5 w-5" />
            </button>
            <label className="sr-only" htmlFor="admin-date">
              Date
            </label>
            <input id="admin-date" type="date" value={date} onChange={(e) => e.target.value && go(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-ash px-3 text-[15px] sm:flex-none sm:px-4" />
            <button type="button" className={iconButton} onClick={() => go(shift(date, 1))} aria-label="Next day">
              <ChevronIcon dir="right" className="h-5 w-5" />
            </button>
            <button type="button" className={`${button} shrink-0 px-3 sm:px-4`} onClick={() => go(today)} disabled={date === today}>
              Today
            </button>
          </div>
          <label className="flex items-center gap-2 text-[15px] sm:ml-auto" htmlFor="admin-branch">
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
        </div>

        <section aria-labelledby="day-heading" className="mt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="day-heading" className="font-display text-2xl">
              {longLabel(date, zone)}
            </h2>
            {data && (
              <p className="text-[15px] text-muted" data-testid="totals">
                <span className="font-display text-2xl text-neem">{data.totals.confirmed}</span> {data.totals.confirmed === 1 ? "booking" : "bookings"},{" "}
                <span className="font-display text-2xl text-neem">{data.totals.covers}</span> {data.totals.covers === 1 ? "guest" : "guests"}
              </p>
            )}
          </div>

          {error && (
            <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-warn-tint px-4 py-3 text-warn">
              {error}
              <button type="button" className={button} onClick={load}>
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
            <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-8 text-center text-[16px] text-muted">No bookings for this day{branch !== "all" ? " at this branch" : ""}.</p>
          )}

          {data && data.items.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-xl border border-line bg-paper">
              <table className="w-full text-left text-[15px]">
                <thead className="border-b border-line bg-ash/60 text-[14px] text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">Time</th>
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
                        <span className="font-medium tabular-nums">{i.timeLabel}</span>
                        {/* On a phone, party and status sit under the time: four columns don't fit 390 px. */}
                        <span className="block text-sm text-muted sm:hidden">
                          {i.partySize} {i.partySize === 1 ? "guest" : "guests"}
                        </span>
                        <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-sm sm:hidden ${i.status === "confirmed" ? "bg-neem-tint text-neem-dark" : "bg-ash text-muted"}`}>{i.status === "confirmed" ? "Confirmed" : "Cancelled"}</span>
                      </td>
                      <td className="px-3 py-3 sm:px-4">
                        {i.guestName}
                        <span className="block text-sm whitespace-nowrap text-muted">{i.phoneLabel}</span>
                        <span className="block text-sm whitespace-nowrap text-muted">
                          {i.ref}
                          <span className="md:hidden"> · {short(i.branch.name)}</span>
                        </span>
                        {i.note && <span className="block text-sm text-muted">Note: {i.note}</span>}
                        {i.status === "confirmed" && (
                          <button type="button" className="mt-1.5 min-h-11 text-[15px] text-warn underline underline-offset-4 sm:hidden" onClick={() => openCancel(i)} aria-label={`Cancel ${i.guestName}'s booking at ${i.timeLabel}`}>
                            Cancel
                          </button>
                        )}
                      </td>
                      <td className="hidden px-4 py-3 tabular-nums sm:table-cell">{i.partySize}</td>
                      <td className="hidden px-4 py-3 md:table-cell">{short(i.branch.name)}</td>
                      <td className="hidden px-4 py-3 sm:table-cell">
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-sm whitespace-nowrap ${i.status === "confirmed" ? "bg-neem-tint text-neem-dark" : "bg-ash text-muted"}`}>{i.status === "confirmed" ? "Confirmed" : "Cancelled"}</span>
                      </td>
                      <td className="hidden px-4 py-2 text-right sm:table-cell">
                        {i.status === "confirmed" && (
                          <button type="button" className={button} onClick={() => openCancel(i)} aria-label={`Cancel ${i.guestName}'s booking at ${i.timeLabel}`}>
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <dialog ref={dialog} aria-labelledby="cancel-title" onClose={() => setCancelling(null)} className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-line bg-paper p-6 text-ink backdrop:bg-black/40">
        {cancelling && (
          <>
            <h2 id="cancel-title" className="font-display text-xl">
              Cancel this booking?
            </h2>
            <p className="mt-2 text-[15px]">
              {cancelling.guestName}, {cancelling.partySize} {cancelling.partySize === 1 ? "guest" : "guests"} at {cancelling.timeLabel}, {short(cancelling.branch.name)} ({cancelling.ref}). The table becomes free for other guests straight away.
            </p>
            {cancelError && (
              <p role="alert" className="mt-3 text-[15px] text-warn">
                {cancelError}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={button} onClick={() => dialog.current?.close()} disabled={busy}>
                Keep booking
              </button>
              <button type="button" className="min-h-11 rounded-full bg-warn px-4 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-60" onClick={confirmCancel} disabled={busy}>
                {busy ? "Cancelling…" : "Cancel booking"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
