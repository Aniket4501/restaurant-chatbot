"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// The staff workspace's shared pieces (D-25), in the Neem & Ember style: cream page, white panels with a subtle line,
// forest green for primary actions and confirmed states, rounded-full controls with 44 px targets.

export const btn = {
  primary: "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-neem px-5 text-[15px] font-medium text-white hover:bg-neem-dark disabled:opacity-50",
  secondary: "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-line bg-paper px-4 text-[15px] hover:border-neem hover:text-neem disabled:opacity-50",
  danger: "inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-bad px-5 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-60",
  link: "inline-flex min-h-11 items-center text-[15px] text-neem underline underline-offset-4 hover:text-neem-dark",
  icon: "flex h-11 w-11 items-center justify-center rounded-full border border-line bg-paper hover:border-neem hover:text-neem",
};
export const inputCls = "min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-[15px] aria-invalid:border-bad";
export const textareaCls = "w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-[15px] leading-relaxed aria-invalid:border-bad";
export const panel = "rounded-2xl border border-line bg-paper";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-3xl sm:text-4xl">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[15px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** A number with its label; the number in the display face, as on the bookings totals. */
export function Stat({ value, label, hint, tone = "neem" }: { value: ReactNode; label: string; hint?: ReactNode; tone?: "neem" | "warn" | "bad" | "muted" }) {
  const color = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "muted" ? "text-muted" : "text-neem";
  return (
    <div className="min-w-0">
      <p className={`font-display text-3xl leading-none tabular-nums ${color}`}>{value}</p>
      <p className="mt-1 text-[14px] text-ink">{label}</p>
      {hint && <p className="text-[13px] text-muted">{hint}</p>}
    </div>
  );
}

export type Tone = "good" | "warn" | "bad" | "neutral" | "info";
const PILL: Record<Tone, string> = { good: "bg-neem-tint text-neem-dark", warn: "bg-warn-tint text-warn", bad: "bg-bad-tint text-bad", neutral: "bg-ash text-muted", info: "border border-line bg-paper text-ink" };
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-[13px] whitespace-nowrap ${PILL[tone]}`}>{children}</span>;
}

export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[14px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[13px] text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[13px] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

/** aria props for an input inside a Field. */
export const describe = (id: string, error?: string | null, hint?: boolean) => ({ id, "aria-invalid": error ? true : undefined, "aria-describedby": error ? `${id}-error` : hint ? `${id}-hint` : undefined });

export function Notice({ tone = "info", children, live = true }: { tone?: "info" | "good" | "warn" | "bad"; children: ReactNode; live?: boolean }) {
  const cls = tone === "bad" ? "border-bad bg-bad-tint text-bad" : tone === "warn" ? "border-warn/30 bg-warn-tint text-warn" : tone === "good" ? "border-neem/20 bg-neem-tint text-neem-dark" : "border-line bg-paper text-ink";
  return (
    <div role={tone === "bad" ? "alert" : live ? "status" : undefined} className={`rounded-xl border px-4 py-3 text-[15px] ${cls}`}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-5 py-8 text-center">
      <p className="font-display text-xl">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-xl text-[15px] text-muted">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-warn-tint px-4 py-3 text-warn">
      {message}
      {onRetry && (
        <button type="button" className={btn.secondary} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div aria-busy="true" aria-label={label} className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-xl bg-paper" />
      ))}
    </div>
  );
}

// ---------- API ----------

export type ApiError = { code: string; message: string; fields?: Record<string, string>; [k: string]: unknown };
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiError };

/** fetch for the admin API: JSON in and out, the error envelope unpacked, network failures as a readable error. */
export async function api<T>(url: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: init.method ?? (init.body !== undefined || init.form ? "POST" : "GET"),
      cache: "no-store",
      ...(init.form ? { body: init.form } : init.body !== undefined ? { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } } : {}),
    });
    const json = await res.json().catch(() => null);
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    const error = (json as { error?: ApiError } | null)?.error ?? { code: "BAD_RESPONSE", message: `The server answered ${res.status}.` };
    return { ok: false, status: res.status, error };
  } catch {
    return { ok: false, status: 0, error: { code: "NETWORK", message: "Couldn't reach the server. Check that the app is running and try again." } };
  }
}

/** Load a GET endpoint; `reload` re-fetches. The first load is deferred so no state is set during an effect's body. */
export function useApi<T>(url: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void>; setData: (d: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!url) return;
    const id = ++seq.current;
    setLoading(true);
    const r = await api<T>(url);
    if (id !== seq.current) return;
    setLoading(false);
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.error.message);
  }, [url]);
  useEffect(() => {
    const t = setTimeout(reload, 0);
    return () => clearTimeout(t);
  }, [reload]);
  return { data, error, loading, reload, setData };
}

// ---------- dialog ----------

/** A modal on the native <dialog> (focus trapped, Escape closes); never window.confirm. */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const titleId = `dlg-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} className={`m-auto max-h-[calc(100dvh-2rem)] ${wide ? "w-[min(44rem,calc(100%-2rem))]" : "w-[min(30rem,calc(100%-2rem))]"} overflow-y-auto rounded-2xl border border-line bg-paper p-6 text-ink backdrop:bg-black/40`}>
      {open && (
        <>
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId} className="font-display text-2xl">
              {title}
            </h2>
            <button type="button" className="-mt-1 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-ash" onClick={onClose} aria-label="Close">
              <span aria-hidden="true" className="text-xl leading-none">
                ×
              </span>
            </button>
          </div>
          <div className="mt-3">{children}</div>
        </>
      )}
    </dialog>
  );
}

/** "Are you sure?" with the action named on the button; the dialog stays open on failure and shows why. */
export function ConfirmDialog({ open, title, body, confirmLabel, busyLabel, tone = "danger", error, busy, onConfirm, onCancel, cancelLabel = "Keep it" }: { open: boolean; title: string; body: ReactNode; confirmLabel: string; busyLabel: string; tone?: "danger" | "primary"; error?: string | null; busy: boolean; onConfirm: () => void; onCancel: () => void; cancelLabel?: string }) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <div className="text-[15px]">{body}</div>
      {error && (
        <p role="alert" className="mt-3 text-[15px] text-bad">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" className={btn.secondary} onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" className={tone === "danger" ? btn.danger : btn.primary} onClick={onConfirm} disabled={busy}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------- formatting ----------

const ZONE = "Asia/Kolkata";
/** "21 Oct, 4:05 PM" in the restaurant's zone (never the browser's). */
export function when(ms: number | null | undefined): string {
  if (!ms) return "never";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: ZONE }).format(new Date(ms)).replace(/\b(am|pm)\b/, (m) => m.toUpperCase());
}
export const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
