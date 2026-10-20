import type { BranchToday, Identity } from "@/lib/chat/identity";
import { ClockIcon, LeafMark, PinIcon } from "@/components/ui/icons";

// The restaurant's hero, the top of the guest chat (§5.10; mobile-first redesign 2026-10-20, after the user's
// mockup). Name, cuisine, an open/closed pill computed from today's hours, and an "Hours and locations" disclosure
// with each branch's address, today's hours and phone. It scrolls with the conversation. No photos (D-18): a
// neem-sprig line illustration on the forest green.

function Pill({ text, open }: { text: string; open: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-smoke-muted/50 bg-white/5 px-3.5 py-1.5 text-[14px] text-smoke-ink">
      <span aria-hidden className={`h-2 w-2 rounded-full ${open ? "bg-[#8fd19e]" : "bg-smoke-muted"}`} />
      {text}
    </span>
  );
}

function Status({ branches }: { branches: BranchToday[] }) {
  const same = branches.every((b) => b.status.text === branches[0]?.status.text);
  if (same && branches[0]) return <Pill text={branches[0].status.text} open={branches[0].status.open} />;
  return (
    <div className="flex flex-col items-center gap-1.5">
      {branches.map((b) => (
        <Pill key={b.slug} text={`${b.short} · ${b.status.text}`} open={b.status.open} />
      ))}
    </div>
  );
}

export function IdentityPanel({ identity }: { identity: Identity }) {
  return (
    <header className="on-smoke relative overflow-hidden rounded-b-[28px] bg-smoke px-6 pt-8 pb-6 text-center text-smoke-ink md:pt-4">
      <LeafMark className="pointer-events-none absolute -top-6 -left-10 h-48 w-48 -rotate-12 text-smoke-muted/10" />
      <LeafMark className="pointer-events-none absolute -right-12 -bottom-10 h-56 w-56 rotate-12 text-smoke-muted/10" />
      <div className="relative">
        <LeafMark className="mx-auto h-10 w-10 text-smoke-ink" />
        <h1 className="mt-2 font-display text-[34px] leading-none tracking-tight">{identity.name}</h1>
        <p className="mx-auto mt-2 max-w-[28ch] text-[14px] text-smoke-muted">{identity.cuisine}</p>
        <div className="mt-4">
          <Status branches={identity.branches} />
        </div>
      </div>
      <details className="relative mt-4 border-t border-white/10 pt-1 text-left">
        <summary className="min-h-11 cursor-pointer content-center text-center text-[15px]">Hours and locations</summary>
        <ul className="space-y-5 pt-2 pb-1">
          {identity.branches.map((b) => (
            <li key={b.slug} className="border-l-2 border-smoke-muted/40 pl-4">
              <h2 className="font-display text-[20px] leading-tight text-smoke-ink">{b.short}</h2>
              <p className="mt-1 flex gap-2 text-[14px] text-smoke-muted">
                <PinIcon className="mt-0.5 h-4 w-4 shrink-0" />
                {b.address}
              </p>
              <p className="mt-1 flex gap-2 text-[14px] text-smoke-ink">
                <ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-smoke-muted" />
                <span>
                  <span className="text-smoke-muted">Today, {b.todayLabel}: </span>
                  {b.services.every((x) => !x.hours) ? "closed" : b.services.map((x) => (x.hours ? `${x.service} ${x.hours}` : `no ${x.service}`)).join(", ")}
                </span>
              </p>
              {b.note && <p className="mt-0.5 pl-6 text-[13px] text-smoke-muted">{b.note}</p>}
              <a href={`tel:${b.phone}`} className="inline-flex min-h-11 items-center pl-6 text-[15px] text-smoke-ink underline decoration-smoke-muted underline-offset-4 hover:decoration-smoke-ink">
                {b.phoneLabel}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </header>
  );
}
