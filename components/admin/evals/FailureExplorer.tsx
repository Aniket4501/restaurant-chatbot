"use client";

import { useMemo, useState } from "react";
import type { AreaInfo, CaseRow } from "@/components/admin/evals/types";
import { SEVERITY_TONE, STATUS_LABEL, STATUS_TONE } from "@/components/admin/evals/format";

// D-21: the cases of the selected run, failing ones first by default. Filters narrow by area, severity, status,
// failure type and change since the comparison run; a row opens the case.

type SortKey = "id" | "area" | "severity" | "status";
const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2 };
const STATUS_ORDER: Record<string, number> = { error: 0, fail: 1, flaky: 2, pass: 3 };

export function FailureExplorer({ rows, areas, hasComparison, onOpen }: { rows: CaseRow[]; areas: AreaInfo[]; hasComparison: boolean; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [area, setArea] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [status, setStatus] = useState("failing");
  const [type, setType] = useState("all");
  const [change, setChange] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "status", dir: 1 });
  const types = useMemo(() => [...new Set(rows.flatMap((r) => (r.failureType ? [r.failureType] : [])))].sort(), [rows]);
  const label = (key: string) => areas.find((a) => a.key === key)?.label ?? key;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter(
      (r) =>
        (status === "all" || (status === "failing" ? r.status !== "pass" : r.status === status)) &&
        (area === "all" || r.area === area) &&
        (severity === "all" || r.severity === severity) &&
        (type === "all" || r.failureType === type) &&
        (change === "all" || r.regression === change) &&
        (!needle || [r.id, r.category, r.failure ?? "", r.actual?.input ?? "", r.actual?.reply ?? ""].some((s) => s.toLowerCase().includes(needle))),
    );
    const areaLabel = new Map(areas.map((a) => [a.key, a.label]));
    const key = (r: CaseRow) => (sort.key === "severity" ? (SEVERITY_ORDER[r.severity] ?? 9) : sort.key === "status" ? STATUS_ORDER[r.status] : sort.key === "area" ? (areaLabel.get(r.area) ?? r.area) : r.id);
    return out.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id)) * sort.dir;
    });
  }, [rows, areas, q, area, severity, status, type, change, sort]);

  const select = "min-h-11 rounded-full border border-line bg-ash px-3 text-[14px]";
  const th = (key: SortKey, text: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className="px-3 py-2 text-left font-medium">
      <button type="button" className="min-h-11 hover:text-neem" onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}>
        {text}
        <span aria-hidden="true" className="ml-1 text-muted">
          {sort.key === key ? (sort.dir === 1 ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );

  return (
    <section aria-labelledby="explorer-heading" className="space-y-3">
      <h2 id="explorer-heading" className="font-display text-2xl">
        Failure explorer
      </h2>
      <div className="flex flex-wrap gap-2 rounded-xl border border-line bg-paper p-2">
        <label className="flex min-w-[14rem] flex-1 items-center">
          <span className="sr-only">Search cases</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ID, input, reply or failure" className="min-h-11 w-full rounded-full border border-line bg-ash px-4 text-[14px]" />
        </label>
        <label className="flex items-center gap-1.5 text-[14px]">
          <span className="text-muted">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={select}>
            <option value="failing">Not passing</option>
            <option value="fail">Failed</option>
            <option value="flaky">Flaky</option>
            <option value="error">Error</option>
            <option value="pass">Passed</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[14px]">
          <span className="text-muted">Area</span>
          <select value={area} onChange={(e) => setArea(e.target.value)} className={select}>
            <option value="all">All</option>
            {areas.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[14px]">
          <span className="text-muted">Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={select}>
            <option value="all">All</option>
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[14px]">
          <span className="text-muted">Failure type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={select}>
            <option value="all">All</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {hasComparison && (
          <label className="flex items-center gap-1.5 text-[14px]">
            <span className="text-muted">Change</span>
            <select value={change} onChange={(e) => setChange(e.target.value)} className={select}>
              <option value="all">Any</option>
              <option value="new">New failure</option>
              <option value="still failing">Still failing</option>
              <option value="resolved">Resolved</option>
              <option value="new case">New case</option>
            </select>
          </label>
        )}
      </div>
      <p className="text-[14px] text-muted" aria-live="polite">
        {shown.length} of {rows.length} cases shown
      </p>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center text-muted">{status === "failing" && rows.every((r) => r.status === "pass") ? "Every case in this run passed." : "No cases match these filters."}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full min-w-[56rem] border-collapse text-[14px]">
            <caption className="sr-only">Cases in the selected run. Activate a case ID to see its details.</caption>
            <thead className="border-b border-line bg-ash/60">
              <tr>
                {th("id", "Case")}
                {th("area", "Area")}
                {th("severity", "Severity")}
                {th("status", "Status")}
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  What happened
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Expected
                </th>
                {hasComparison && (
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Before
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-line align-top last:border-0 hover:bg-ash/40">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <button type="button" onClick={() => onOpen(r.id)} className="min-h-11 text-left text-neem underline decoration-line underline-offset-4 hover:decoration-neem">
                      {r.id}
                    </button>
                    {r.regression === "new" && <span className="ml-1.5 rounded-full bg-bad px-2 py-0.5 text-[12px] text-white">new failure</span>}
                    {r.regression === "resolved" && <span className="ml-1.5 rounded-full bg-neem-tint px-2 py-0.5 text-[12px] text-neem">resolved</span>}
                  </th>
                  <td className="px-3 py-2">{label(r.area)}</td>
                  <td className={`px-3 py-2 capitalize ${SEVERITY_TONE[r.severity] ?? ""}`}>{r.severity}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[13px] font-medium ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                    {r.runs > 1 && <span className="ml-1 text-[12px] text-muted">{r.passes}/{r.runs}</span>}
                  </td>
                  <td className="max-w-[22rem] px-3 py-2">
                    {r.failure ? <p className="text-bad">{r.failure}</p> : <p className="text-muted">All checks met</p>}
                    {r.actual && (
                      <p className="mt-1 line-clamp-2 text-[13px] text-muted">
                        “{r.actual.input}” → {r.actual.reply || r.actual.outcome || "no reply"}
                      </p>
                    )}
                  </td>
                  <td className="max-w-[16rem] px-3 py-2 text-[13px] text-muted">{r.expected.length ? r.expected.slice(0, 3).join("; ") : "Invariants only"}</td>
                  {hasComparison && <td className="px-3 py-2 text-[13px]">{r.previous ? STATUS_LABEL[r.previous] : "Not run"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
