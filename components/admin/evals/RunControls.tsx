"use client";

import { useState } from "react";
import type { AreaInfo, Job, JobRequest } from "@/components/admin/evals/types";
import { duration } from "@/components/admin/evals/format";

// D-21: start a real eval run (the runner in a child process) and follow it. One run at a time; a live run uses the
// local model, so the guest chat is slower while it runs.

const STATE_TEXT: Record<Job["state"], string> = { running: "Running", passed: "Finished: every case passed", failed: "Finished with failures", cancelled: "Cancelled", error: "Couldn't run" };

export function RunControls({ job, areas, onStart, onCancel, onView, startError, nowMs }: { job: Job | null; areas: AreaInfo[]; onStart: (r: JobRequest) => void; onCancel: () => void; onView: (runId: string) => void; startError: string | null; nowMs: number }) {
  const [mode, setMode] = useState<JobRequest["mode"]>("scripted");
  const [suite, setSuite] = useState<JobRequest["suite"]>("smoke");
  const [area, setArea] = useState("all");
  const running = job?.state === "running";
  const total = job?.progress.total ?? null;
  const done = job?.progress.done ?? 0;
  const radio = (name: string, value: string, current: string, set: (v: string) => void, label: string, hint: string) => (
    <label className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 ${current === value ? "border-neem bg-neem-tint" : "border-line bg-paper"}`}>
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => set(value)} className="mt-1 accent-[var(--neem)]" />
      <span>
        <span className="block text-[15px] font-medium">{label}</span>
        <span className="block text-[13px] text-muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <section aria-labelledby="run-heading" className="rounded-2xl border border-line bg-paper p-4 sm:p-5">
      <h2 id="run-heading" className="font-display text-2xl">
        Run evals
      </h2>
      <form
        className="mt-3 grid gap-3 lg:grid-cols-[1fr_1fr_auto_auto] lg:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          onStart({ mode, suite, area: area === "all" ? null : area, caseIds: null });
        }}
      >
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-[14px] text-muted">Model</legend>
          {radio("mode", "scripted", mode, (v) => setMode(v as JobRequest["mode"]), "Scripted", "Fake model, scripted replies: seconds")}
          {radio("mode", "live", mode, (v) => setMode(v as JobRequest["mode"]), "Live", "Local Ollama model: minutes; chat slows down")}
        </fieldset>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-[14px] text-muted">Suite</legend>
          {radio("suite", "smoke", suite, (v) => setSuite(v as JobRequest["suite"]), "Smoke", "A few cases per area")}
          {radio("suite", "full", suite, (v) => setSuite(v as JobRequest["suite"]), "Full", "Every case")}
        </fieldset>
        <label className="flex flex-col gap-1 text-[14px]">
          <span className="text-muted">Area</span>
          <select value={area} onChange={(e) => setArea(e.target.value)} className="min-h-11 rounded-full border border-line bg-ash px-3 text-[14px]">
            <option value="all">All areas</option>
            {areas.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={running} className="min-h-11 rounded-full bg-neem px-5 text-[15px] font-medium text-white hover:bg-neem-dark disabled:opacity-50">
          Start run
        </button>
      </form>
      {startError && (
        <p role="alert" className="mt-3 rounded-xl bg-bad-tint px-4 py-3 text-[14px] text-bad">
          {startError}
        </p>
      )}
      <div aria-live="polite" className="mt-3">
        {job && (
          <div className={`rounded-xl border px-4 py-3 ${job.state === "running" ? "border-sage bg-ash" : job.state === "passed" ? "border-line bg-neem-tint" : "border-line bg-warn-tint"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[15px]">
                <span className="font-medium">{STATE_TEXT[job.state]}</span> · {job.request.caseIds ? `case ${job.request.caseIds.join(", ")}` : `${job.request.mode} ${job.request.suite}${job.request.area ? `, ${areas.find((a) => a.key === job.request.area)?.label ?? job.request.area}` : ""}`} · {duration((job.finishedAt ? Date.parse(job.finishedAt) : nowMs) - Date.parse(job.startedAt))}
              </p>
              <div className="flex gap-2">
                {running && (
                  <button type="button" onClick={onCancel} className="min-h-11 rounded-full border border-line bg-paper px-4 text-[14px] hover:border-bad hover:text-bad">
                    Cancel run
                  </button>
                )}
                {!running && job.runId && (
                  <button type="button" onClick={() => onView(job.runId!)} className="min-h-11 rounded-full border border-neem bg-paper px-4 text-[14px] text-neem hover:bg-neem hover:text-white">
                    View results
                  </button>
                )}
              </div>
            </div>
            {total !== null && (
              <div className="mt-2">
                <div role="progressbar" aria-label="Cases run" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-2 overflow-hidden rounded-full bg-line">
                  <div className="h-full bg-neem transition-[width]" style={{ width: `${Math.min(100, (done / Math.max(1, total)) * 100)}%` }} />
                </div>
                <p className="mt-1 text-[13px] text-muted">
                  {done} of {total} cases run{job.progress.failed ? `, ${job.progress.failed} failed so far` : ""}
                </p>
              </div>
            )}
            {job.error && <p className="mt-2 text-[14px] text-bad">{job.error}</p>}
            {job.log.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[14px] text-neem">Runner output (last {job.log.length} lines)</summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-smoke p-3 text-[12px] leading-relaxed whitespace-pre-wrap text-smoke-ink">{job.log.join("\n")}</pre>
              </details>
            )}
            <p className="mt-2 text-[12px] text-muted">
              Command: <code>{job.command}</code>
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
