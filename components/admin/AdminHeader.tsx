import Link from "next/link";
import { LeafMark } from "@/components/ui/icons";

// The staff header (D-16 admin, D-21): the brand and the two staff pages. No sign-in or sign-out (D-22).
export function AdminHeader({ current }: { current: "bookings" | "evals" }) {
  const tab = (href: string, label: string, key: typeof current) => (
    <Link href={href} aria-current={current === key ? "page" : undefined} className={`flex min-h-11 items-center rounded-full px-4 text-[15px] ${current === key ? "bg-smoke-ink text-smoke" : "text-smoke-ink hover:bg-white/10"}`}>
      {label}
    </Link>
  );
  return (
    <header className="on-smoke bg-smoke text-smoke-ink">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:px-8">
        <p className="flex items-center gap-2.5 font-display text-xl">
          <LeafMark className="h-6 w-6" />
          Neem &amp; Ember <span className="font-sans text-[15px] text-smoke-muted">Staff</span>
        </p>
        <nav aria-label="Staff pages" className="flex gap-1">
          {tab("/admin", "Bookings", "bookings")}
          {tab("/admin/evals", "Evals", "evals")}
        </nav>
      </div>
    </header>
  );
}
