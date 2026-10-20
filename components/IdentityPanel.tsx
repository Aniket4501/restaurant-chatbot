import type { Identity } from "@/lib/chat/identity";
import { ClockIcon, LeafMark, PinIcon } from "@/components/ui/icons";

// The restaurant's identity panel (§5.10, restyled to the 2026-10-20 brief): name, cuisine, and each branch's address,
// phone and today's hours, on the deep forest green. On a phone it is a compact header with an "Hours and locations"
// disclosure, and the chat becomes the page. No photos: a neem-sprig line illustration stands in (D-18).

function Branches({ identity }: { identity: Identity }) {
  return (
    <ul className="space-y-6">
      {identity.branches.map((b) => (
        <li key={b.slug} className="border-l-2 border-smoke-muted/40 pl-4">
          <h2 className="font-display text-[22px] leading-tight text-smoke-ink">{b.short}</h2>
          <p className="mt-1.5 flex gap-2 text-[15px] text-smoke-muted">
            <PinIcon className="mt-0.5 h-4 w-4 shrink-0" />
            {b.address}
          </p>
          <p className="mt-1 flex gap-2 text-[15px] text-smoke-ink">
            <ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-smoke-muted" />
            <span>
              <span className="text-smoke-muted">Today, {b.todayLabel}: </span>
              {b.services.every((x) => !x.hours) ? "closed" : b.services.map((x) => (x.hours ? `${x.service} ${x.hours}` : `no ${x.service}`)).join(", ")}
            </span>
          </p>
          {b.note && <p className="mt-0.5 pl-6 text-[14px] text-smoke-muted">{b.note}</p>}
          <a href={`tel:${b.phone}`} className="mt-1 inline-flex min-h-11 items-center pl-6 text-[15px] text-smoke-ink underline decoration-smoke-muted underline-offset-4 hover:decoration-smoke-ink">
            {b.phoneLabel}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function IdentityPanel({ identity }: { identity: Identity }) {
  return (
    <header className="on-smoke relative overflow-hidden bg-smoke text-smoke-ink lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-[min(40%,30rem)] lg:shrink-0 lg:flex-col lg:overflow-y-auto">
      <LeafMark className="pointer-events-none absolute -right-10 -bottom-6 hidden h-80 w-80 text-smoke-muted/15 lg:block" />
      <div className="relative flex items-center gap-3 px-5 py-4 lg:block lg:px-10 lg:pt-14 lg:pb-10">
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-smoke-muted/50 lg:mb-6 lg:h-14 lg:w-14">
          <LeafMark className="h-6 w-6 lg:h-8 lg:w-8" />
        </span>
        <div>
          <h1 className="font-display text-[26px] leading-none tracking-tight lg:text-[52px]">{identity.name}</h1>
          <p className="mt-1.5 max-w-[30ch] text-[14px] text-smoke-muted lg:mt-3 lg:text-[17px]">{identity.cuisine}</p>
        </div>
      </div>
      <details className="relative border-t border-white/10 px-5 py-1 lg:hidden">
        <summary className="min-h-11 cursor-pointer content-center text-[15px]">Hours and locations</summary>
        <div className="pt-3 pb-4">
          <Branches identity={identity} />
        </div>
      </details>
      <div className="relative hidden flex-1 border-t border-white/10 px-10 py-10 lg:block">
        <Branches identity={identity} />
      </div>
    </header>
  );
}
