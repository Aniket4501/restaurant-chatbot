"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { BookIcon, CalendarIcon, ChartIcon, ClockIcon, CloseIcon, HomeIcon, LeafMark, ListIcon, MenuBookIcon, PinIcon, QuestionIcon } from "@/components/ui/icons";

// The staff workspace frame (D-25): forest-green navigation beside the page on wide screens, a top bar with a page
// list on phones. The current page is marked with aria-current and the cream pill the old header tabs used.

const NAV = [
  { href: "/admin", label: "Overview", icon: HomeIcon, exact: true },
  { href: "/admin/bookings", label: "Bookings", icon: CalendarIcon },
  { href: "/admin/menu", label: "Menu", icon: MenuBookIcon },
  { href: "/admin/knowledge", label: "Knowledge base", icon: BookIcon },
  { href: "/admin/faqs", label: "FAQs", icon: QuestionIcon },
  { href: "/admin/availability", label: "Availability", icon: ClockIcon },
  { href: "/admin/branches", label: "Branches", icon: PinIcon },
  { href: "/admin/evals", label: "Evals", icon: ChartIcon },
] as const;

const isCurrent = (path: string, item: (typeof NAV)[number]) => ("exact" in item && item.exact ? path === item.href : path === item.href || path.startsWith(`${item.href}/`));

function NavLinks({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  return (
    <ul className="space-y-1">
      {NAV.map((item) => {
        const current = isCurrent(path, item);
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={current ? "page" : undefined}
              className={`flex min-h-11 items-center gap-3 rounded-full px-4 text-[15px] ${current ? "bg-smoke-ink text-smoke" : "text-smoke-ink hover:bg-white/10"}`}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Brand() {
  return (
    <p className="flex min-w-0 items-center gap-2.5">
      <LeafMark className="h-6 w-6 shrink-0" />
      <span className="min-w-0 leading-tight">
        <span className="block font-display text-lg whitespace-nowrap">Neem &amp; Ember</span>
        <span className="block text-[13px] text-smoke-muted">Staff workspace</span>
      </span>
    </p>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/admin";
  const [open, setOpen] = useState(false);
  const current = NAV.find((n) => isCurrent(path, n));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      {/* Wide screens: the navigation stays beside the page. */}
      <aside className="on-smoke hidden bg-smoke text-smoke-ink lg:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 px-3 py-5">
          <div className="px-3">
            <Brand />
          </div>
          <nav aria-label="Staff pages">
            <NavLinks path={path} />
          </nav>
          <p className="mt-auto px-4 text-[13px] text-smoke-muted">
            <Link href="/" className="underline underline-offset-4 hover:text-smoke-ink">
              Open the guest chat
            </Link>
          </p>
        </div>
      </aside>

      {/* Phones and tablets: a top bar; the page list opens below it. */}
      <header className="on-smoke sticky top-0 z-30 bg-smoke text-smoke-ink lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <Brand />
          <button type="button" aria-expanded={open} aria-controls="staff-nav" onClick={() => setOpen((o) => !o)} className="flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/20 px-3 text-[15px] hover:bg-white/10">
            {open ? <CloseIcon className="h-5 w-5" /> : <ListIcon className="h-5 w-5" />}
            <span className="max-w-[8.5rem] truncate">{open ? "Close" : current?.label ?? "Pages"}</span>
            <span className="sr-only">: staff pages</span>
          </button>
        </div>
        {open && (
          <nav id="staff-nav" aria-label="Staff pages" className="border-t border-white/10 px-3 pt-2 pb-4">
            <NavLinks path={path} onNavigate={() => setOpen(false)} />
          </nav>
        )}
      </header>

      <div className="min-w-0">{children}</div>
    </div>
  );
}
