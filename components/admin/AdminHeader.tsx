"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LeafMark } from "@/components/ui/icons";

// The staff header (D-16 admin, D-21): the brand, the two staff pages, and sign out.
export function AdminHeader({ current }: { current: "bookings" | "evals" }) {
  const router = useRouter();
  const signOut = async () => {
    await fetch("/api/admin/session", { method: "DELETE" }).catch(() => null);
    router.replace("/admin/login");
  };
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
        <nav aria-label="Staff pages" className="order-3 flex w-full gap-1 sm:order-none sm:w-auto">
          {tab("/admin", "Bookings", "bookings")}
          {tab("/admin/evals", "Evals", "evals")}
        </nav>
        <button type="button" onClick={signOut} className="min-h-11 text-[15px] underline decoration-smoke-muted underline-offset-4 hover:decoration-smoke-ink">
          Sign out
        </button>
      </div>
    </header>
  );
}
