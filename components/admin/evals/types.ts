import type { BenchSummary, Comparison, RunSummary } from "@/evals/report";
import type { CaseResult } from "@/evals/run";
import type { CaseRow } from "@/lib/api/evals";
import type { Job, JobRequest } from "@/lib/evals/jobs";

// D-21: what the evals API returns (type-only imports: nothing server-side reaches the client bundle).
export type AreaInfo = { key: string; label: string; about: string };
export type Overview = { runs: RunSummary[]; totalRuns: number; baseline: Record<string, { id: string; setAt: string; note: string | null }>; areas: AreaInfo[]; job: Job | null; benches: BenchSummary[] };
export type RunDetail = { run: RunSummary; base: RunSummary | null; baseReason: "chosen" | "baseline" | "previous" | "none"; comparison: Comparison | null; cases: CaseRow[] };
export type CaseDetail = {
  run: RunSummary;
  caseId: string;
  area: string;
  spec: { notes: string | null; now: string; turns: number; variantOf: string | null; version: number } | null;
  results: CaseResult[];
  rerun: { command: string; request: JobRequest };
};
export type { BenchSummary, CaseRow, Job, JobRequest, RunSummary, Comparison, CaseResult };
