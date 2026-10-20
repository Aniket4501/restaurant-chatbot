"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

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

  const signOut = async () => {
    await fetch("/api/admin/session", { method: "DELETE" }).catch(() => null);
    router.replace("/admin/login");
  };

  const button = "min-h-11 rounded-md border border-line bg-paper px-4 text-[15px] hover:border-neem hover:text-neem disabled:opacity-50";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-4">
        <h1 className="font-display text-3xl">Bookings</h1>
        <button type="button" onClick={signOut} className="min-h-11 text-[15px] underline decoration-line underline-offset-4 hover:text-neem">
          Sign out
        </button>
      </header>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Date" className="flex flex-wrap items-center gap-2">
          <button type="button" className={button} onClick={() => go(shift(date, -1))}>
            Previous day
          </button>
          <button type="button" className={button} onClick={() => go(today)} disabled={date === today}>
            Today
          </button>
          <button type="button" className={button} onClick={() => go(shift(date, 1))}>
            Next day
          </button>
          <label className="sr-only" htmlFor="admin-date">
            Date
          </label>
          <input id="admin-date" type="date" value={date} onChange={(e) => e.target.value && go(e.target.value)} className="min-h-11 rounded-md border border-line bg-white px-3 text-[15px]" />
        </div>
        <label className="text-[15px]" htmlFor="admin-branch">
          <span className="mr-2">Branch</span>
          <select
            id="admin-branch"
            value={branch}
            onChange={(e) => {
              setData(null);
              setBranch(e.target.value);
            }}
            className="min-h-11 rounded-md border border-line bg-white px-3 text-[15px]"
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
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="day-heading" className="font-display text-2xl">
            {longLabel(date, zone)}
          </h2>
          {data && (
            <p className="text-[15px] text-muted" data-testid="totals">
              {data.totals.confirmed} {data.totals.confirmed === 1 ? "booking" : "bookings"}, {data.totals.covers} {data.totals.covers === 1 ? "guest" : "guests"}
            </p>
          )}
        </div>

        {error && (
          <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-warn-tint px-4 py-3 text-warn">
            {error}
            <button type="button" className={button} onClick={load}>
              Retry
            </button>
          </div>
        )}

        {!data && !error && (
          <div aria-busy="true" aria-label="Loading bookings" className="mt-4 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-paper" />
            ))}
          </div>
        )}

        {data && data.items.length === 0 && <p className="mt-6 text-[16px] text-muted">No bookings for this day{branch !== "all" ? " at this branch" : ""}.</p>}

        {data && data.items.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-paper">
            <table className="w-full min-w-[46rem] text-left text-[15px]">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-normal">Time</th>
                  <th scope="col" className="px-4 py-3 font-normal">Guest</th>
                  <th scope="col" className="px-4 py-3 font-normal">Party</th>
                  <th scope="col" className="px-4 py-3 font-normal">Branch</th>
                  <th scope="col" className="px-4 py-3 font-normal">Status</th>
                  <th scope="col" className="px-4 py-3 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.ref} className={`border-b border-line last:border-0 ${i.status === "cancelled" ? "text-muted" : ""}`}>
                    <td className="px-4 py-3 tabular-nums">{i.timeLabel}</td>
                    <td className="px-4 py-3">
                      {i.guestName}
                      <span className="block text-sm text-muted">
                        {i.phoneLabel} · {i.ref}
                      </span>
                      {i.note && <span className="block text-sm text-muted">Note: {i.note}</span>}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{i.partySize}</td>
                    <td className="px-4 py-3">{short(i.branch.name)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-sm ${i.status === "confirmed" ? "bg-neem-tint text-neem-dark" : "bg-ash text-muted"}`}>{i.status === "confirmed" ? "Confirmed" : "Cancelled"}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
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

      <dialog ref={dialog} aria-labelledby="cancel-title" onClose={() => setCancelling(null)} className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg border border-line bg-paper p-6 text-ink backdrop:bg-black/40">
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
              <button type="button" className="min-h-11 rounded-md bg-warn px-4 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-60" onClick={confirmCancel} disabled={busy}>
                {busy ? "Cancelling…" : "Cancel booking"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
