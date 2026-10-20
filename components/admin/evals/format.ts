import type { CaseStatus, RunSummary, Stat } from "@/evals/report";

// D-21 dashboard formatting. A value with no data is shown as "No data", never as 0%.

export const pct = (v: number | null, digits = 1) => (v === null ? "No data" : `${(v * 100).toFixed(digits)}%`);
export const pts = (d: number | null) => (d === null ? null : `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)} pts`);
export const ms = (v: number | null) => (v === null ? "No data" : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v).toLocaleString("en-GB")} ms`);
export function duration(v: number | null): string {
  if (v === null) return "—";
  const s = Math.round(v / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date(iso));
export const clock = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date(iso)).replace(",", "");
export const shortWhen = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));

export function statValue(s: Pick<Stat, "value" | "kind">): string {
  if (s.value === null) return "No data";
  if (s.kind === "rate") return pct(s.value);
  if (s.kind === "ms") return ms(s.value);
  return String(s.value);
}
export function statDelta(before: number | null, after: number | null, kind: Stat["kind"]): string | null {
  if (before === null || after === null) return null;
  const d = after - before;
  if (kind === "rate") return pts(d);
  if (kind === "ms") return `${d >= 0 ? "+" : "−"}${ms(Math.abs(d))}`;
  return `${d >= 0 ? "+" : "−"}${Math.abs(d)}`;
}

export const runLabel = (s: Pick<RunSummary, "mode" | "suite" | "startedAt" | "status">) => `${s.mode === "live" ? "Live" : "Scripted"} ${s.suite === "subset" ? "subset" : s.suite} · ${when(s.startedAt)}${s.status !== "complete" ? ` · ${s.status}` : ""}`;

export const STATUS_LABEL: Record<CaseStatus, string> = { pass: "Passed", fail: "Failed", error: "Error", flaky: "Flaky" };
export const STATUS_TONE: Record<CaseStatus, string> = { pass: "bg-neem-tint text-neem", fail: "bg-bad-tint text-bad", error: "bg-bad text-white", flaky: "bg-warn-tint text-warn" };
export const SEVERITY_TONE: Record<string, string> = { critical: "text-bad", major: "text-ink", minor: "text-muted" };
