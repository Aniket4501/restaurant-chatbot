"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { api, btn, ConfirmDialog, describe, ErrorBox, Field, inputCls, Loading, Modal, Notice, PageHeader, Pill, plural, textareaCls, useApi, panel } from "@/components/admin/ui";

// Branches (D-25): restaurant-wide details, then each branch's stored details, hours summary and what is specific
// to it (dishes, FAQs, documents, tables, upcoming bookings). Name, address and phone are editable; slugs and time
// zones are fixed because bookings and the chatbot's facts depend on them.

type Branch = {
  slug: string;
  name: string;
  shortName: string;
  address: string;
  phone: string;
  phoneLabel: string;
  timezone: string;
  isActive: boolean;
  counts: { tables: number; seats: number; menuOnlyHere: number; faqs: number; documents: number; upcomingBookings: number };
  hours: { label: string; lunch: string; dinner: string }[];
  specialDates: { date: string; label: string; summary: string }[];
};
type Data = { restaurant: { name: string; cuisine: string; about: string }; branches: Branch[]; menuEverywhere: number; globalFaqs: number; globalDocuments: number };

export function BranchesPage() {
  const { data, error, reload } = useApi<Data>("/api/admin/branches");
  const [editing, setEditing] = useState<Branch | null>(null);
  const [editingRestaurant, setEditingRestaurant] = useState(false);
  const [notice, setNotice] = useState<{ tone: "good" | "warn" | "bad"; text: string } | null>(null);
  const [toggling, setToggling] = useState<Branch | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggleConflicts, setToggleConflicts] = useState<{ ref: string; dateLabel: string; timeLabel: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async (confirm = false) => {
    if (!toggling) return;
    setBusy(true);
    setToggleError(null);
    const r = await api<{ changed: boolean }>(`/api/admin/branches/${toggling.slug}`, { method: "PATCH", body: { isActive: !toggling.isActive, ...(confirm ? { confirm: true } : {}) } });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409 && Array.isArray(r.error.conflicts)) return setToggleConflicts(r.error.conflicts as { ref: string; dateLabel: string; timeLabel: string }[]);
      return setToggleError(r.error.message);
    }
    setNotice({ tone: "good", text: toggling.isActive ? `${toggling.shortName} is inactive: guests can't book it and the chatbot no longer mentions it.` : `${toggling.shortName} is active again.` });
    setToggling(null);
    setToggleConflicts(null);
    await reload();
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8">
      <PageHeader title="Branches" description="Restaurant-wide details and each branch's own. The chatbot introduces the restaurant and answers address, phone and hours questions from these." />
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {error && <ErrorBox message={`Couldn't load the branches. ${error}`} onRetry={reload} />}
      {!data && !error && <Loading label="Loading the branches" rows={3} />}
      {data && (
        <>
          <section aria-labelledby="rest-h" className={`${panel} p-5`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="rest-h" className="font-display text-2xl">
                  {data.restaurant.name}
                </h2>
                <p className="text-[15px]">{data.restaurant.cuisine}</p>
                <p className="mt-1 max-w-3xl text-[15px] text-muted">{data.restaurant.about}</p>
              </div>
              <button type="button" className={btn.secondary} onClick={() => setEditingRestaurant(true)}>
                Edit restaurant details
              </button>
            </div>
            <p className="mt-3 text-[14px] text-muted">
              Shared by every branch: {plural(data.menuEverywhere, "dish", "dishes")} served everywhere, {plural(data.globalFaqs, "FAQ")} and {plural(data.globalDocuments, "document")} for all branches.
            </p>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            {data.branches.map((b) => (
              <section key={b.slug} aria-labelledby={`b-${b.slug}`} className={`${panel} space-y-3 p-5`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 id={`b-${b.slug}`} className="font-display text-2xl">
                      {b.shortName}
                    </h2>
                    <p className="text-[14px] text-muted">{b.name}</p>
                  </div>
                  <Pill tone={b.isActive ? "good" : "neutral"}>{b.isActive ? "Active" : "Inactive"}</Pill>
                </div>
                <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-[15px]">
                  <dt className="text-muted">Address</dt>
                  <dd>{b.address}</dd>
                  <dt className="text-muted">Phone</dt>
                  <dd>{b.phoneLabel}</dd>
                  <dt className="text-muted">Time zone</dt>
                  <dd>{b.timezone}</dd>
                </dl>
                <div>
                  <h3 className="text-[15px] font-medium">Weekly hours</h3>
                  <table className="mt-1 w-full text-[14px]">
                    <thead className="sr-only">
                      <tr>
                        <th scope="col">Day</th>
                        <th scope="col">Lunch</th>
                        <th scope="col">Dinner</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.hours.map((h) => (
                        <tr key={h.label}>
                          <td className="py-0.5 pr-3">{h.label}</td>
                          <td className={`py-0.5 pr-3 ${h.lunch === "Closed" ? "text-muted" : ""}`}>{h.lunch}</td>
                          <td className={`py-0.5 ${h.dinner === "Closed" ? "text-muted" : ""}`}>{h.dinner}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {b.specialDates.length > 0 && (
                    <p className="mt-1 text-[13px] text-muted">
                      Special dates: {b.specialDates.map((s) => `${s.label} (${s.summary})`).join("; ")}
                    </p>
                  )}
                </div>
                <p className="text-[14px] text-muted">
                  {plural(b.counts.tables, "table")} ({b.counts.seats} seats at most) · {plural(b.counts.upcomingBookings, "upcoming booking")} · {plural(b.counts.menuOnlyHere, "dish", "dishes")}, {plural(b.counts.faqs, "FAQ")} and {plural(b.counts.documents, "document")} only here
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={btn.secondary} onClick={() => setEditing(b)}>
                    Edit details
                  </button>
                  <Link href="/admin/availability" className={btn.secondary}>
                    Hours and tables
                  </Link>
                  <button type="button" className={btn.secondary} onClick={() => (setToggleError(null), setToggleConflicts(null), setToggling(b))}>
                    {b.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      {editing && (
        <BranchEditor
          branch={editing}
          onClose={() => setEditing(null)}
          onSaved={async (summary) => {
            setEditing(null);
            setNotice({ tone: "good", text: summary === "no change" ? "Nothing to save: no changes." : `Saved (${summary}). The chatbot uses the new details from its next reply.` });
            await reload();
          }}
        />
      )}
      {editingRestaurant && data && (
        <RestaurantEditor
          value={data.restaurant}
          onClose={() => setEditingRestaurant(false)}
          onSaved={async (summary) => {
            setEditingRestaurant(false);
            setNotice({ tone: "good", text: summary === "no change" ? "Nothing to save: no changes." : `Saved the restaurant's ${summary}.` });
            await reload();
          }}
        />
      )}
      <ConfirmDialog
        open={!!toggling}
        title={toggling?.isActive ? `Deactivate ${toggling.shortName}?` : `Activate ${toggling?.shortName ?? ""}?`}
        tone={toggling?.isActive ? "danger" : "primary"}
        body={
          toggleConflicts ? (
            <>
              <p>These confirmed bookings are at this branch. They stay booked if you deactivate it; contact the guests.</p>
              <ul className="mt-2 list-disc pl-5 text-[14px]">
                {toggleConflicts.map((c) => (
                  <li key={c.ref}>
                    {c.ref}, {c.dateLabel} at {c.timeLabel}
                  </li>
                ))}
              </ul>
            </>
          ) : toggling?.isActive ? (
            <p>Guests won&apos;t be able to book {toggling.shortName}, and the chatbot will stop mentioning it, its dishes and its FAQs.</p>
          ) : (
            <p>Guests can book it again and the chatbot will include it.</p>
          )
        }
        confirmLabel={toggleConflicts ? "Deactivate anyway" : toggling?.isActive ? "Deactivate" : "Activate"}
        busyLabel="Saving…"
        cancelLabel="Cancel"
        error={toggleError}
        busy={busy}
        onConfirm={() => toggle(!!toggleConflicts)}
        onCancel={() => !busy && (setToggling(null), setToggleConflicts(null))}
      />
    </main>
  );
}

function BranchEditor({ branch, onClose, onSaved }: { branch: Branch; onClose: () => void; onSaved: (summary: string) => void }) {
  const [name, setName] = useState(branch.name);
  const [address, setAddress] = useState(branch.address);
  const [phone, setPhone] = useState(branch.phoneLabel);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const short = name.split(", ").pop() ?? name;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api<{ changed: boolean; summary: string }>(`/api/admin/branches/${branch.slug}`, { method: "PATCH", body: { name, address, phone } });
    setBusy(false);
    if (!r.ok) {
      setFields(r.error.fields ?? {});
      return setError(r.error.message);
    }
    onSaved(r.data.summary);
  };
  return (
    <Modal open onClose={() => !busy && onClose()} title={`Edit ${branch.shortName}`}>
      <form onSubmit={save} noValidate className="space-y-4">
        <Field id="br-name" label="Name" hint={`Guests and the chatbot call it "${short}" (the part after the last comma).`} error={fields.name}>
          <input {...describe("br-name", fields.name, true)} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field id="br-address" label="Address" error={fields.address}>
          <textarea {...describe("br-address", fields.address)} className={textareaCls} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
        </Field>
        <Field id="br-phone" label="Phone" hint="An Indian landline or mobile number, for example +91 11 4155 0101." error={fields.phone}>
          <input {...describe("br-phone", fields.phone, true)} className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        </Field>
        {error && (
          <p role="alert" className="text-[15px] text-bad">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RestaurantEditor({ value, onClose, onSaved }: { value: Data["restaurant"]; onClose: () => void; onSaved: (summary: string) => void }) {
  const [form, setForm] = useState(value);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api<{ changed: boolean; summary: string }>("/api/admin/restaurant", { method: "PATCH", body: form });
    setBusy(false);
    if (!r.ok) {
      setFields(r.error.fields ?? {});
      return setError(r.error.message);
    }
    onSaved(r.data.summary);
  };
  return (
    <Modal open onClose={() => !busy && onClose()} title="Restaurant details">
      <form onSubmit={save} noValidate className="space-y-4">
        <Field id="r-name" label="Restaurant name" error={fields.name}>
          <input {...describe("r-name", fields.name)} className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} />
        </Field>
        <Field id="r-cuisine" label="Cuisine" error={fields.cuisine}>
          <input {...describe("r-cuisine", fields.cuisine)} className={inputCls} value={form.cuisine} onChange={(e) => setForm({ ...form, cuisine: e.target.value })} maxLength={120} />
        </Field>
        <Field id="r-about" label="About" hint="The chatbot uses this when it introduces the restaurant." error={fields.about}>
          <textarea {...describe("r-about", fields.about, true)} className={textareaCls} rows={3} value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} maxLength={400} />
        </Field>
        {error && (
          <p role="alert" className="text-[15px] text-bad">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
