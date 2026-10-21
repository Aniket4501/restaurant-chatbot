"use client";

import Link from "next/link";
import { AlertIcon } from "@/components/ui/icons";
import { ErrorBox, Loading, PageHeader, Pill, Stat, useApi, when, panel, plural } from "@/components/admin/ui";

// The staff landing page (D-25): today's bookings, what's coming up, and the health of the data the chatbot answers
// from. Every figure is a count from the database or a check run on load; nothing is estimated or decorative.

type Change = { id: number; at: number; area: string; action: string; target: string; summary: string };
type Overview = {
  todayLabel: string;
  bookings: {
    today: { confirmed: number; covers: number; cancelled: number; byBranch: { slug: string; name: string; confirmed: number; covers: number }[] };
    next: { ref: string; timeLabel: string; partySize: number; branch: string; guestName: string }[];
    nextDays: { date: string; label: string; confirmed: number; covers: number }[];
  };
  menu: { listed: number; available: number; unavailable: number; removed: number; lastChange: Change | null };
  faqs: { active: number; inactive: number; conflicts: number; lastChange: Change | null };
  knowledge: { documents: number; searchable: number; keywordOnly: number; failed: number; mode: "hybrid" | "keyword"; reason: string | null; refreshPending: boolean; lastRefreshStatus: string | null };
  warnings: { tone: "bad" | "warn"; title: string; detail: string; href: string }[];
  changes: Change[];
};

const AREA: Record<string, string> = { menu: "Menu", faq: "FAQs", knowledge: "Knowledge base", hours: "Hours", exceptions: "Special dates", blocks: "Slot blocks", tables: "Tables", branches: "Branches", restaurant: "Restaurant", bookings: "Bookings" };

export function OverviewPage({ serverNow }: { serverNow: number }) {
  const { data, error, reload } = useApi<Overview>("/api/admin/overview");
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8">
      <PageHeader title="Overview" description={data ? `${data.todayLabel}. Bookings, and the menu, FAQs and documents the chatbot answers from.` : "Bookings, and the menu, FAQs and documents the chatbot answers from."} />
      {error && <ErrorBox message={`Couldn't load the overview. ${error}`} onRetry={reload} />}
      {!data && !error && <Loading label="Loading the overview" rows={4} />}
      {data && (
        <>
          {data.warnings.length > 0 ? (
            <section aria-labelledby="warn-h" className="space-y-2">
              <h2 id="warn-h" className="sr-only">
                Needs attention
              </h2>
              {data.warnings.map((w, i) => (
                <Link key={i} href={w.href} className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-[15px] hover:underline ${w.tone === "bad" ? "border-bad bg-bad-tint text-bad" : "border-warn/30 bg-warn-tint text-warn"}`}>
                  <AlertIcon className="mt-0.5 h-5 w-5 shrink-0" />
                  <span>
                    <span className="font-medium">{w.title}</span>
                    {w.detail && <span className="block text-[14px]">{w.detail}</span>}
                  </span>
                </Link>
              ))}
            </section>
          ) : (
            <p className="text-[15px] text-muted">No problems found: every upcoming booking fits the hours and tables, and the chatbot&apos;s data is indexed.</p>
          )}

          <section aria-labelledby="today-h" className={`${panel} p-5`}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="today-h" className="font-display text-2xl">
                Today&apos;s bookings
              </h2>
              <Link href="/admin/bookings" className="text-[15px] text-neem underline underline-offset-4">
                Open bookings
              </Link>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
              <Stat value={data.bookings.today.confirmed} label={data.bookings.today.confirmed === 1 ? "booking" : "bookings"} />
              <Stat value={data.bookings.today.covers} label={data.bookings.today.covers === 1 ? "guest" : "guests"} />
              <Stat value={data.bookings.today.cancelled} label="cancelled" tone="muted" />
              {data.bookings.today.byBranch.map((b) => (
                <Stat key={b.slug} value={b.confirmed} label={b.name} hint={plural(b.covers, "guest")} tone="muted" />
              ))}
            </div>
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <div>
                <h3 className="text-[15px] font-medium">Next up today</h3>
                {data.bookings.next.length ? (
                  <ul className="mt-2 divide-y divide-line">
                    {data.bookings.next.map((b) => (
                      <li key={b.ref} className="flex items-baseline justify-between gap-3 py-2 text-[15px]">
                        <span>
                          <span className="font-medium tabular-nums">{b.timeLabel}</span> {b.guestName}, {plural(b.partySize, "guest")}
                        </span>
                        <span className="text-[14px] text-muted">
                          {b.branch} · {b.ref}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[15px] text-muted">No more confirmed bookings today.</p>
                )}
              </div>
              <div>
                <h3 className="text-[15px] font-medium">The next six days</h3>
                <table className="mt-2 w-full text-[15px]">
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Bookings</th>
                      <th scope="col">Guests</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.bookings.nextDays.map((d) => (
                      <tr key={d.date}>
                        <td className="py-2">{d.label}</td>
                        <td className="py-2 text-right tabular-nums">{plural(d.confirmed, "booking")}</td>
                        <td className="py-2 text-right text-muted tabular-nums">{plural(d.covers, "guest")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section aria-labelledby="data-h">
            <h2 id="data-h" className="font-display text-2xl">
              What the chatbot answers from
            </h2>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Link href="/admin/menu" className={`${panel} block p-5 hover:border-neem`}>
                <h3 className="text-[15px] font-medium">Menu</h3>
                <p className="mt-2 font-display text-3xl text-neem tabular-nums">{data.menu.available}</p>
                <p className="text-[14px]">dishes available of {data.menu.listed} on the menu</p>
                <p className="mt-2 text-[14px] text-muted">
                  {plural(data.menu.unavailable, "unavailable", "unavailable")} · {data.menu.removed} removed
                </p>
                <p className="mt-2 text-[13px] text-muted">{data.menu.lastChange ? `Last edit ${when(data.menu.lastChange.at)}` : "No staff edits yet"}</p>
              </Link>
              <Link href="/admin/faqs" className={`${panel} block p-5 hover:border-neem`}>
                <h3 className="text-[15px] font-medium">FAQs</h3>
                <p className="mt-2 font-display text-3xl text-neem tabular-nums">{data.faqs.active}</p>
                <p className="text-[14px]">active answers</p>
                <p className="mt-2 text-[14px] text-muted">
                  {data.faqs.inactive} inactive · {data.faqs.conflicts ? <span className="text-warn">{plural(data.faqs.conflicts, "possible conflict")}</span> : "no conflicts"}
                </p>
                <p className="mt-2 text-[13px] text-muted">{data.faqs.lastChange ? `Last edit ${when(data.faqs.lastChange.at)}` : "No staff edits yet"}</p>
              </Link>
              <Link href="/admin/knowledge" className={`${panel} block p-5 hover:border-neem`}>
                <h3 className="text-[15px] font-medium">Knowledge base</h3>
                <p className="mt-2 font-display text-3xl text-neem tabular-nums">{data.knowledge.documents}</p>
                <p className="text-[14px]">{data.knowledge.documents === 1 ? "document" : "documents"}</p>
                <p className="mt-2 text-[14px] text-muted">
                  {data.knowledge.searchable} searchable{data.knowledge.keywordOnly ? `, ${data.knowledge.keywordOnly} keyword only` : ""}
                  {data.knowledge.failed ? <span className="text-bad">, {data.knowledge.failed} failed</span> : ""}
                </p>
                <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted">
                  Search: {data.knowledge.mode === "hybrid" ? <Pill tone="good">meaning and keywords</Pill> : <Pill tone="warn">keywords only</Pill>}
                  {data.knowledge.refreshPending && <Pill tone="info">refreshing</Pill>}
                </p>
              </Link>
            </div>
          </section>

          <section aria-labelledby="changes-h" className={`${panel} p-5`}>
            <h2 id="changes-h" className="font-display text-2xl">
              Recent staff changes
            </h2>
            {data.changes.length ? (
              <ul className="mt-2 divide-y divide-line">
                {data.changes.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-[15px]">
                    <span>
                      <span className="text-muted">{AREA[c.area] ?? c.area}:</span> {c.summary}
                    </span>
                    <span className="text-[13px] text-muted">{when(c.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[15px] text-muted">Nothing changed in this workspace yet. Edits to the menu, FAQs, documents, hours and branches appear here.</p>
            )}
            <p className="mt-3 text-[13px] text-muted">Loaded {when(serverNow)}.</p>
          </section>
        </>
      )}
    </main>
  );
}
