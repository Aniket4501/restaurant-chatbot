"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ChevronIcon } from "@/components/ui/icons";
import { api, btn, describe, ErrorBox, Field, inputCls, Loading, Notice, PageHeader, Pill, rupees, textareaCls, useApi, when, panel } from "@/components/admin/ui";
import { COURSES, courseLabel, guestLabels, MENU_STATUS, SPICE, shortBranch } from "@/components/admin/labels";

// One dish (D-25): the editable fields the menu table has, a preview of the dish card guests see in the chat, the
// exact fact the chatbot reads, and whether the keyword index and the semantic vectors are current for it.

type Item = { slug: string; name: string; category: string; description: string; priceInr: number; dietary: string[]; spiceLevel: number | null; branches: string[] | null; scopeLabel: string | null; status: "available" | "unavailable" | "removed"; createdBy: "seed" | "staff"; updatedAt: number | null };
type Detail = { item: Item; fact: { id: string; text: string } | null; listedIn: string[]; index: { keyword: string; vector: string }; changes: { id: number; at: number; action: string; summary: string }[] };
type Branches = { branches: { slug: string; name: string; isActive: boolean }[] };

type Form = { name: string; description: string; category: string; price: string; diet: "none" | "vegetarian" | "vegan"; glutenFree: boolean; jain: boolean; dairy: boolean; nuts: boolean; egg: boolean; spice: string; scope: "all" | "some"; branches: string[]; status: Item["status"] };

const blank: Form = { name: "", description: "", category: "", price: "", diet: "none", glutenFree: false, jain: false, dairy: false, nuts: false, egg: false, spice: "", scope: "all", branches: [], status: "available" };

function toForm(i: Item): Form {
  const d = i.dietary;
  return { name: i.name, description: i.description, category: i.category, price: String(i.priceInr), diet: d.includes("vegan") ? "vegan" : d.includes("vegetarian") ? "vegetarian" : "none", glutenFree: d.includes("gluten-free"), jain: d.includes("jain-available"), dairy: d.includes("contains-dairy"), nuts: d.includes("contains-nuts"), egg: d.includes("egg"), spice: i.spiceLevel === null ? "" : String(i.spiceLevel), scope: i.branches ? "some" : "all", branches: i.branches ?? [], status: i.status };
}

function dietaryOf(f: Form): string[] {
  return [f.diet === "vegan" ? "vegan" : f.diet === "vegetarian" ? "vegetarian" : null, f.glutenFree && "gluten-free", f.jain && "jain-available", f.dairy && "contains-dairy", f.nuts && "contains-nuts", f.egg && "egg"].filter((x): x is string => !!x);
}

const INDEX: Record<string, { label: string; tone: "good" | "warn" | "neutral" | "bad" }> = {
  current: { label: "current", tone: "good" },
  stale: { label: "updating", tone: "warn" },
  missing: { label: "not yet stored", tone: "warn" },
  not_indexed: { label: "not used", tone: "neutral" },
};

export function MenuItemPage({ slug, justCreated = false }: { slug: string | null; justCreated?: boolean }) {
  const router = useRouter();
  const detail = useApi<Detail>(slug ? `/api/admin/menu/${slug}` : null);
  const branches = useApi<Branches>("/api/admin/branches");
  const [form, setForm] = useState<Form | null>(slug ? null : blank);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(justCreated ? { tone: "good", text: "Added to the menu. The chatbot can suggest it from its next reply." } : null);
  const [saving, setSaving] = useState(false);

  // The form starts from the saved dish once it loads (and again after each save).
  const f = form ?? (detail.data ? toForm(detail.data.item) : null);
  const set = (patch: Partial<Form>) => setForm({ ...(f as Form), ...patch });
  const active = (branches.data?.branches ?? []).filter((b) => b.isActive);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!f || saving) return;
    setMessage(null);
    const local: Record<string, string> = {};
    if (!f.name.trim()) local.name = "Enter a name";
    if (f.description.trim().length < 5) local.description = "Describe the dish in a few words";
    if (!f.category) local.category = "Choose a section";
    if (!/^\d+$/.test(f.price) || Number(f.price) < 1) local.priceInr = "Enter the price in whole rupees";
    if (f.diet === "vegan" && (f.dairy || f.egg)) local.dietary = "A vegan dish can't contain dairy or egg";
    if (f.scope === "some" && !f.branches.length) local.branches = "Choose at least one branch, or all branches";
    setFields(local);
    if (Object.keys(local).length) return;
    const body = { name: f.name, description: f.description, category: f.category, priceInr: Number(f.price), dietary: dietaryOf(f), spiceLevel: f.spice === "" ? null : Number(f.spice), branches: f.scope === "all" ? null : f.branches, status: slug ? f.status : f.status === "removed" ? "available" : f.status };
    setSaving(true);
    const r = slug ? await api<{ changed: boolean; summary: string }>(`/api/admin/menu/${slug}`, { method: "PATCH", body }) : await api<{ item: Item }>("/api/admin/menu", { body });
    setSaving(false);
    if (!r.ok) {
      setFields(r.error.fields ?? {});
      setMessage({ tone: "bad", text: r.error.message });
      return;
    }
    if (!slug) {
      router.push(`/admin/menu/${(r.data as { item: Item }).item.slug}?created=1`);
      return;
    }
    const changed = (r.data as { changed: boolean; summary: string }).changed;
    setMessage({ tone: "good", text: changed ? `Saved (${(r.data as { summary: string }).summary}). The chatbot uses it from its next reply; its search index updates in the background.` : "Nothing to save: no changes." });
    setForm(null);
    await detail.reload();
  };

  if (slug && detail.error) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-8">
        <BackLink />
        <ErrorBox message={detail.error === "Menu item not found." ? "This dish isn't on the menu." : `Couldn't load this dish. ${detail.error}`} onRetry={detail.reload} />
      </main>
    );
  }
  if (!f) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-8">
        <BackLink />
        <Loading label="Loading the dish" />
      </main>
    );
  }

  const g = guestLabels(dietaryOf(f));
  const item = detail.data?.item;
  const scopeNames = f.scope === "some" ? active.filter((b) => f.branches.includes(b.slug)).map((b) => shortBranch(b.name)) : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-8">
      <BackLink />
      <PageHeader
        title={slug ? item?.name ?? "Dish" : "Add a dish"}
        description={slug && item ? <>{courseLabel(item.category)} · {item.createdBy === "staff" ? "added by staff" : "from the seed menu"}{item.updatedAt ? `, last edited ${when(item.updatedAt)}` : ""}</> : "New dishes reach the chatbot as soon as you save."}
        actions={slug && item ? <Pill tone={MENU_STATUS[item.status].tone}>{MENU_STATUS[item.status].label}</Pill> : undefined}
      />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <form onSubmit={save} noValidate className={`${panel} space-y-4 p-5`} aria-label={slug ? "Edit dish" : "New dish"}>
          <Field id="m-name" label="Name" error={fields.name}>
            <input {...describe("m-name", fields.name)} className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} />
          </Field>
          <Field id="m-desc" label="Description" hint="What's in it, in the words guests see. Ingredients and allergens beyond the labels below aren't recorded anywhere else." error={fields.description}>
            <textarea {...describe("m-desc", fields.description, true)} className={textareaCls} rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="m-cat" label="Section" hint="The menu section is also the course guests ask for." error={fields.category}>
              <select {...describe("m-cat", fields.category, true)} className={inputCls} value={f.category} onChange={(e) => set({ category: e.target.value })}>
                <option value="">Choose…</option>
                {COURSES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="m-price" label="Price (₹, whole rupees)" error={fields.priceInr}>
              <input {...describe("m-price", fields.priceInr)} className={inputCls} inputMode="numeric" value={f.price} onChange={(e) => set({ price: e.target.value.replace(/[^\d]/g, "") })} />
            </Field>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-[14px] font-medium">Diet</legend>
            <div className="flex flex-wrap gap-2">
              {(["none", "vegetarian", "vegan"] as const).map((d) => (
                <label key={d} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-[15px] ${f.diet === d ? "border-neem bg-neem-tint" : "border-line bg-paper"}`}>
                  <input type="radio" name="diet" value={d} checked={f.diet === d} onChange={() => set({ diet: d, ...(d === "vegan" ? { dairy: false, egg: false } : {}) })} />
                  {d === "none" ? "Not vegetarian" : d === "vegetarian" ? "Vegetarian" : "Vegan"}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-[14px] font-medium">Labels and allergens</legend>
            <p className="text-[13px] text-muted">Only tick what the kitchen has confirmed. The chatbot treats a missing label as unknown, never as safe.</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {([
                ["glutenFree", "Gluten-free"],
                ["jain", "Jain option available"],
                ["dairy", "Contains dairy"],
                ["nuts", "Contains nuts"],
                ["egg", "Contains egg"],
              ] as const).map(([k, label]) => (
                <label key={k} className="flex min-h-11 items-center gap-2 text-[15px]">
                  <input type="checkbox" checked={f[k]} disabled={f.diet === "vegan" && (k === "dairy" || k === "egg")} onChange={(e) => set({ [k]: e.target.checked } as Partial<Form>)} />
                  {label}
                </label>
              ))}
            </div>
            {fields.dietary && <p className="text-[13px] text-bad">{fields.dietary}</p>}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="m-spice" label="Spice level" hint="Leave as not listed if the kitchen hasn't said." error={fields.spiceLevel}>
              <select {...describe("m-spice", fields.spiceLevel, true)} className={inputCls} value={f.spice} onChange={(e) => set({ spice: e.target.value })}>
                <option value="">Not listed</option>
                {SPICE.map((s, i) => (
                  <option key={s} value={String(i)}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="m-status" label="Availability" hint={f.status === "unavailable" ? "Still on the menu; the chatbot says it's unavailable and never suggests it." : f.status === "removed" ? "Hidden from guests and the chatbot until you restore it." : undefined} error={fields.status}>
              <select {...describe("m-status", fields.status, true)} className={inputCls} value={f.status} onChange={(e) => set({ status: e.target.value as Item["status"] })}>
                <option value="available">Available</option>
                <option value="unavailable">Unavailable (sold out, out of season)</option>
                {slug && <option value="removed">Removed from the menu</option>}
              </select>
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-[14px] font-medium">Branches</legend>
            <div className="flex flex-wrap gap-x-5">
              <label className="flex min-h-11 items-center gap-2 text-[15px]">
                <input type="radio" name="scope" checked={f.scope === "all"} onChange={() => set({ scope: "all", branches: [] })} />
                Every branch
              </label>
              <label className="flex min-h-11 items-center gap-2 text-[15px]">
                <input type="radio" name="scope" checked={f.scope === "some"} onChange={() => set({ scope: "some" })} />
                Only some branches
              </label>
            </div>
            {f.scope === "some" && (
              <div className="flex flex-wrap gap-x-5 pl-6">
                {active.map((b) => (
                  <label key={b.slug} className="flex min-h-11 items-center gap-2 text-[15px]">
                    <input type="checkbox" checked={f.branches.includes(b.slug)} onChange={(e) => set({ branches: e.target.checked ? [...f.branches, b.slug] : f.branches.filter((x) => x !== b.slug) })} />
                    {shortBranch(b.name)}
                  </label>
                ))}
              </div>
            )}
            {fields.branches && <p className="text-[13px] text-bad">{fields.branches}</p>}
          </fieldset>
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            {slug && form && (
              <button type="button" className={btn.secondary} onClick={() => (setForm(null), setFields({}), setMessage(null))} disabled={saving}>
                Undo changes
              </button>
            )}
            <button type="submit" className={btn.primary} disabled={saving}>
              {saving ? "Saving…" : slug ? "Save changes" : "Add dish"}
            </button>
          </div>
        </form>

        <aside className="space-y-4">
          <section aria-labelledby="preview-h" className="space-y-2">
            <h2 id="preview-h" className="text-[15px] font-medium">
              In the guest chat
            </h2>
            {f.status === "available" ? (
              <article aria-label={`Preview: ${f.name || "new dish"}`} className="rounded-2xl border border-line bg-paper p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-[19px] leading-tight">{f.name || "Dish name"}</h3>
                  <span className="shrink-0 text-[16px] font-medium text-neem tabular-nums">{f.price ? rupees(Number(f.price)) : "₹—"}</span>
                </div>
                <p className="mt-0.5 text-[13px] text-muted">{f.category ? courseLabel(f.category) : "Section"}</p>
                <p className="mt-2 text-[15px] leading-relaxed">{f.description || "Description"}</p>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {g.labels.map((l) => (
                    <span key={l} className="rounded-full bg-neem-tint px-2 py-0.5 text-[12px] text-neem-dark">
                      {l}
                    </span>
                  ))}
                  <span className="text-[13px] text-muted">{[f.spice === "" ? null : SPICE[Number(f.spice)], g.contains.length ? `Contains ${g.contains.join(", ")}` : null, scopeNames.length ? `${scopeNames.join(" and ")} only` : null].filter(Boolean).join(" · ")}</span>
                </div>
              </article>
            ) : (
              <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-[14px] text-muted">{f.status === "unavailable" ? "Guests don't see this dish in menus or suggestions while it's unavailable. Asked about it, the chatbot says it's unavailable." : "Removed dishes don't appear anywhere in the chat."}</p>
            )}
            <p className="text-[13px] text-muted">The preview follows the form; save to update the chat.</p>
          </section>

          {slug && detail.data && (
            <section aria-labelledby="fact-h" className={`${panel} space-y-2 p-4`}>
              <h2 id="fact-h" className="text-[15px] font-medium">
                What the chatbot reads (saved version)
              </h2>
              {detail.data.fact ? <p className="rounded-xl bg-ash px-3 py-2 font-mono text-[13px] leading-relaxed break-words">{detail.data.fact.text}</p> : <p className="text-[14px] text-muted">Nothing: removed dishes aren&apos;t sent to the chatbot.</p>}
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                Keyword search <Pill tone={INDEX[detail.data.index.keyword].tone}>{INDEX[detail.data.index.keyword].label}</Pill> Semantic search <Pill tone={INDEX[detail.data.index.vector].tone}>{INDEX[detail.data.index.vector].label}</Pill>
              </p>
              {detail.data.listedIn.length > 0 && <p className="text-[13px] text-muted">Also listed in: {detail.data.listedIn.map((id) => (id.startsWith("menu-cat:") ? `${courseLabel(id.slice(9))} list` : `${id.slice(10).replace(/-/g, " ")} list`)).join(", ")}.</p>}
              {(detail.data.index.vector === "stale" || detail.data.index.vector === "missing") && (
                <button type="button" className={btn.link} onClick={() => detail.reload()}>
                  Check again
                </button>
              )}
            </section>
          )}

          {slug && detail.data && detail.data.changes.length > 0 && (
            <section aria-labelledby="hist-h" className={`${panel} p-4`}>
              <h2 id="hist-h" className="text-[15px] font-medium">
                Changes
              </h2>
              <ul className="mt-1 space-y-1 text-[14px]">
                {detail.data.changes.map((c) => (
                  <li key={c.id}>
                    <span className="text-muted">{when(c.at)}:</span> {c.summary}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/admin/menu" className="inline-flex min-h-11 items-center gap-1 text-[15px] text-neem underline-offset-4 hover:underline">
      <ChevronIcon dir="left" className="h-4 w-4" />
      Back to the menu
    </Link>
  );
}
