import type { Identity } from "@/lib/chat/identity";

// The restaurant's identity panel (§5.10): name, cuisine, and each branch's address, phone and today's hours. On a
// phone it collapses to the name with a "Hours and locations" disclosure, and the chat becomes the page.

function Branches({ identity }: { identity: Identity }) {
  return (
    <ul className="space-y-7">
      {identity.branches.map((b) => (
        <li key={b.slug}>
          <h2 className="font-display text-[22px] leading-tight text-smoke-ink">{b.short}</h2>
          <p className="mt-1 text-[15px] text-smoke-muted">{b.address}</p>
          <p className="mt-2 text-[15px] text-smoke-ink">
            <span className="text-smoke-muted">Today, {b.todayLabel}: </span>
            {b.services.every((x) => !x.hours) ? "closed" : b.services.map((x) => (x.hours ? `${x.service} ${x.hours}` : `no ${x.service}`)).join(", ")}
          </p>
          {b.note && <p className="mt-0.5 text-[14px] text-smoke-muted">{b.note}</p>}
          <a href={`tel:${b.phone}`} className="mt-2 inline-flex min-h-11 items-center text-[15px] text-smoke-ink underline decoration-smoke-muted underline-offset-4 hover:decoration-smoke-ink">
            {b.phoneLabel}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function IdentityPanel({ identity }: { identity: Identity }) {
  return (
    <header className="on-smoke bg-smoke text-smoke-ink lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-[min(40%,30rem)] lg:shrink-0 lg:flex-col lg:overflow-y-auto">
      <div className="px-5 py-5 lg:px-10 lg:pt-14 lg:pb-10">
        <h1 className="font-display text-[34px] leading-none tracking-tight lg:text-[52px]">{identity.name}</h1>
        <p className="mt-3 max-w-[30ch] text-[15px] text-smoke-muted lg:text-[17px]">{identity.cuisine}</p>
      </div>
      <details className="border-t border-white/10 px-5 py-3 lg:hidden">
        <summary className="min-h-11 cursor-pointer content-center text-[15px]">Hours and locations</summary>
        <div className="pt-3 pb-2">
          <Branches identity={identity} />
        </div>
      </details>
      <div className="hidden flex-1 border-t border-white/10 px-10 py-10 lg:block">
        <Branches identity={identity} />
      </div>
    </header>
  );
}
