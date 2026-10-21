"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { btn, EmptyState, ErrorBox, inputCls, Loading, PageHeader, Pill, rupees, Stat, useApi, panel } from "@/components/admin/ui";
import { COURSES, courseLabel, guestLabels, MENU_STATUS } from "@/components/admin/labels";

// Menu management list (D-25): the chatbot's own menu table, with search, filters, sorting and pages.

type Item = { slug: string; name: string; category: string; categoryLabel: string; description: string; priceInr: number; dietary: string[]; spiceLevel: number | null; branches: string[] | null; scopeLabel: string | null; status: "available" | "unavailable" | "removed"; createdBy: "seed" | "staff"; updatedAt: number | null; order: number };
type Menu = { items: Item[]; counts: { total: number; listed: number; available: number; unavailable: number; removed: number }; byCategory: { category: string; label: string; listed: number; available: number }[] };

const PAGE = 20;
const DIETS = [
  { key: "", label: "Any label" },
  { key: "vegetarian", label: "Vegetarian (incl. vegan)" },
  { key: "vegan", label: "Vegan" },
  { key: "non-veg", label: "Non-vegetarian" },
  { key: "gluten-free", label: "Gluten-free" },
  { key: "jain-available", label: "Jain option" },
  { key: "contains-nuts", label: "Contains nuts" },
  { key: "contains-dairy", label: "Contains dairy" },
  { key: "egg", label: "Contains egg" },
];

const dietMatch = (d: string[], k: string) => (!k ? true : k === "vegetarian" ? d.includes("vegetarian") || d.includes("vegan") : k === "non-veg" ? !d.includes("vegetarian") && !d.includes("vegan") : d.includes(k));

export function MenuPage() {
  const { data, error, reload } = useApi<Menu>("/api/admin/menu");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("listed");
  const [diet, setDiet] = useState("");
  const [sort, setSort] = useState("menu");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    const out = data.items.filter(
      (i) =>
        (!term || i.name.toLowerCase().includes(term) || i.description.toLowerCase().includes(term)) &&
        (!category || i.category === category) &&
        (status === "all" ? true : status === "listed" ? i.status !== "removed" : i.status === status) &&
        dietMatch(i.dietary, diet),
    );
    const by: Record<string, (a: Item, b: Item) => number> = {
      menu: (a, b) => a.order - b.order,
      name: (a, b) => a.name.localeCompare(b.name),
      "price-asc": (a, b) => a.priceInr - b.priceInr || a.name.localeCompare(b.name),
      "price-desc": (a, b) => b.priceInr - a.priceInr || a.name.localeCompare(b.name),
    };
    return out.sort(by[sort]);
  }, [data, q, category, status, diet, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * PAGE, current * PAGE + PAGE);
  const reset = (f: () => void) => {
    f();
    setPage(0);
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8">
      <PageHeader
        title="Menu"
        description="The dishes the chatbot knows and suggests. Changes reach the chatbot on its next reply."
        actions={
          <Link href="/admin/menu/new" className={btn.primary}>
            <PlusIcon className="h-5 w-5" />
            Add a dish
          </Link>
        }
      />
      {error && <ErrorBox message={`Couldn't load the menu. ${error}`} onRetry={reload} />}
      {!data && !error && <Loading label="Loading the menu" />}
      {data && (
        <>
          <section aria-label="Menu summary" className={`${panel} flex flex-wrap gap-x-10 gap-y-4 p-5`}>
            <Stat value={data.counts.listed} label="on the menu" />
            <Stat value={data.counts.available} label="available" />
            <Stat value={data.counts.unavailable} label="unavailable" tone={data.counts.unavailable ? "warn" : "muted"} />
            <Stat value={data.counts.removed} label="removed" tone="muted" />
            <div className="min-w-0 text-[14px] text-muted">
              <p className="text-ink">By section</p>
              <p className="mt-1 max-w-md">{data.byCategory.map((c) => `${c.label} ${c.available}/${c.listed}`).join(" · ")}</p>
              <p className="mt-0.5 text-[13px]">available / listed</p>
            </div>
          </section>

          <section aria-label="Filters" className="grid gap-2 rounded-xl border border-line bg-paper p-2 sm:grid-cols-2 lg:grid-cols-[1.5fr_repeat(4,1fr)]">
            <div className="relative">
              <label htmlFor="menu-q" className="sr-only">
                Search dishes
              </label>
              <SearchIcon className="pointer-events-none absolute top-3 left-3 h-5 w-5 text-muted" />
              <input id="menu-q" type="search" value={q} onChange={(e) => reset(() => setQ(e.target.value))} placeholder="Search name or description" className={`${inputCls} pl-10`} />
            </div>
            <label className="sr-only" htmlFor="menu-cat">
              Section
            </label>
            <select id="menu-cat" value={category} onChange={(e) => reset(() => setCategory(e.target.value))} className={inputCls}>
              <option value="">All sections</option>
              {COURSES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="menu-status">
              Availability
            </label>
            <select id="menu-status" value={status} onChange={(e) => reset(() => setStatus(e.target.value))} className={inputCls}>
              <option value="listed">On the menu</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable</option>
              <option value="removed">Removed</option>
              <option value="all">Everything</option>
            </select>
            <label className="sr-only" htmlFor="menu-diet">
              Label
            </label>
            <select id="menu-diet" value={diet} onChange={(e) => reset(() => setDiet(e.target.value))} className={inputCls}>
              {DIETS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="menu-sort">
              Sort
            </label>
            <select id="menu-sort" value={sort} onChange={(e) => setSort(e.target.value)} className={inputCls}>
              <option value="menu">Menu order</option>
              <option value="name">Name</option>
              <option value="price-asc">Price, low to high</option>
              <option value="price-desc">Price, high to low</option>
            </select>
          </section>

          {filtered.length === 0 ? (
            <EmptyState title="No dishes match" action={<button type="button" className={btn.secondary} onClick={() => reset(() => (setQ(""), setCategory(""), setStatus("listed"), setDiet("")))}>Clear filters</button>}>
              Try another search or filter.
            </EmptyState>
          ) : (
            <section aria-label="Dishes">
              <p className="mb-2 text-[14px] text-muted" aria-live="polite">
                Showing {current * PAGE + 1}–{current * PAGE + shown.length} of {filtered.length}
              </p>
              <div className="overflow-hidden rounded-xl border border-line bg-paper">
                <table className="w-full text-left text-[15px]">
                  <thead className="border-b border-line bg-ash/60 text-[14px] text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 font-medium">Dish</th>
                      <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">Section</th>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">Price</th>
                      <th scope="col" className="hidden px-4 py-2.5 font-medium sm:table-cell">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i) => {
                      const g = guestLabels(i.dietary);
                      return (
                        <tr key={i.slug} className={`border-b border-line align-top last:border-0 ${i.status === "removed" ? "text-muted" : ""}`}>
                          <td className="px-4 py-3">
                            <Link href={`/admin/menu/${i.slug}`} className="font-medium text-ink underline-offset-4 hover:text-neem hover:underline">
                              {i.name}
                            </Link>
                            <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{i.description}</p>
                            <p className="mt-1 flex flex-wrap gap-1 text-[12px]">
                              {g.labels.map((l) => (
                                <span key={l} className="rounded-full bg-neem-tint px-2 py-0.5 text-neem-dark">
                                  {l}
                                </span>
                              ))}
                              {g.contains.length > 0 && <span className="px-1 py-0.5 text-muted">Contains {g.contains.join(", ")}</span>}
                              {i.scopeLabel && <span className="px-1 py-0.5 text-muted">{i.scopeLabel}</span>}
                              {i.createdBy === "staff" && <span className="px-1 py-0.5 text-muted">Added by staff</span>}
                            </p>
                            <span className="mt-1 inline-block sm:hidden">
                              <Pill tone={MENU_STATUS[i.status].tone}>{MENU_STATUS[i.status].label}</Pill>
                            </span>
                          </td>
                          <td className="hidden px-4 py-3 md:table-cell">{courseLabel(i.category)}</td>
                          <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">{rupees(i.priceInr)}</td>
                          <td className="hidden px-4 py-3 sm:table-cell">
                            <Pill tone={MENU_STATUS[i.status].tone}>{MENU_STATUS[i.status].label}</Pill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <nav aria-label="Pages of dishes" className="mt-3 flex items-center justify-between gap-2">
                  <button type="button" className={btn.secondary} disabled={current === 0} onClick={() => setPage(current - 1)}>
                    Previous page
                  </button>
                  <span className="text-[14px] text-muted">
                    Page {current + 1} of {pages}
                  </span>
                  <button type="button" className={btn.secondary} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                    Next page
                  </button>
                </nav>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
