"use client";

// D-21: small SVG charts (no chart library). Each has a text description for screen readers and draws only the
// points it is given; a missing value is a gap, never a zero.

/** Which x labels to draw: at most `max`, always the last, never one crowding the last. */
function showLabel(i: number, n: number, max: number): boolean {
  if (n <= max) return true;
  const step = Math.ceil(n / max);
  return i === n - 1 || (i % step === 0 && n - 1 - i >= Math.ceil(step / 2) + 1);
}

export type Series = { label: string; values: (number | null)[]; tone: "neem" | "sage" | "bad" | "warn" | "ink"; dashed?: boolean };
const STROKE: Record<Series["tone"], string> = { neem: "var(--neem)", sage: "var(--sage)", bad: "var(--bad)", warn: "var(--warn)", ink: "var(--ink)" };

export function LineChart({ title, labels, series, yMax, format, height = 180, width = 560 }: { title: string; labels: string[]; series: Series[]; yMax?: number; format: (v: number) => string; height?: number; width?: number }) {
  const W = width;
  const H = height;
  const pad = { l: 52, r: 12, t: 12, b: 28 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const top = yMax ?? Math.max(1, ...all) * 1.1;
  const x = (i: number) => pad.l + (labels.length <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (labels.length - 1));
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const desc = series.map((s) => `${s.label}: ${s.values.map((v, i) => `${labels[i]} ${v === null ? "no data" : format(v)}`).join(", ")}`).join(". ");
  return (
    <figure className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${desc}`} className="h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {format(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => (showLabel(i, labels.length, W > 800 ? 10 : 6) ? (
          <text key={`${l}-${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {l}
          </text>
        ) : null))}
        {series.map((s) => {
          const segs: string[] = [];
          let cur = "";
          s.values.forEach((v, i) => {
            if (v === null) {
              if (cur) segs.push(cur);
              cur = "";
            } else cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
          });
          if (cur) segs.push(cur);
          return (
            <g key={s.label}>
              {segs.map((d) => (
                <path key={d} d={d} fill="none" stroke={STROKE[s.tone]} strokeWidth={2} strokeDasharray={s.dashed ? "5 4" : undefined} />
              ))}
              {s.values.map((v, i) => (v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={3} fill="var(--paper)" stroke={STROKE[s.tone]} strokeWidth={2} />))}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line x1="0" x2="18" y1="3" y2="3" stroke={STROKE[s.tone]} strokeWidth={2} strokeDasharray={s.dashed ? "5 4" : undefined} />
            </svg>
            {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function BarChart({ title, labels, values, format, tone = "bad", height = 140 }: { title: string; labels: string[]; values: number[]; format: (v: number) => string; tone?: Series["tone"]; height?: number }) {
  const W = 560;
  const H = height;
  const pad = { l: 36, r: 12, t: 12, b: 28 };
  const top = Math.max(1, ...values);
  const bw = Math.min(36, ((W - pad.l - pad.r) / Math.max(1, values.length)) * 0.6);
  const x = (i: number) => pad.l + ((i + 0.5) * (W - pad.l - pad.r)) / Math.max(1, values.length);
  const h = (v: number) => (v / top) * (H - pad.t - pad.b);
  return (
    <figure className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${values.map((v, i) => `${labels[i]} ${format(v)}`).join(", ")}`} className="h-auto w-full">
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--line)" />
        {values.map((v, i) => (
          <g key={i}>
            <rect x={x(i) - bw / 2} y={H - pad.b - h(v)} width={bw} height={Math.max(v ? 2 : 0, h(v))} rx={3} fill={STROKE[tone]} />
            <text x={x(i)} y={H - pad.b - h(v) - 4} textAnchor="middle" fontSize={11} fill="var(--ink)">
              {format(v)}
            </text>
            {showLabel(i, values.length, 6) && (
              <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {labels[i]}
              </text>
            )}
          </g>
        ))}
      </svg>
    </figure>
  );
}

/** A tiny trend line for an area tile; nothing is drawn with fewer than two points. */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return null;
  const W = 96;
  const H = 28;
  const x = (i: number) => 2 + (i * (W - 4)) / Math.max(1, values.length - 1);
  const y = (v: number) => 2 + (1 - v) * (H - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${label} over the last ${pts.length} runs: ${pts.map((p) => `${Math.round(p[1] * 100)}%`).join(", ")}`}>
      <path d={pts.map((p, k) => `${k ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")} fill="none" stroke="var(--sage)" strokeWidth={2} />
      <circle cx={x(pts.at(-1)![0])} cy={y(pts.at(-1)![1])} r={2.5} fill="var(--neem)" />
    </svg>
  );
}
