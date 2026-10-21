import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { serverFiles } from "./env";

// D-21 evals dashboard on the test-mode server. Its results directory is seeded with two fixture runs (a baseline
// and a later run) by scripts/e2e-prepare.ts; the numbers expected here are computed from those files, and the run
// button starts the real runner (scripted smoke) and is checked against the results file it writes.

const FIXTURES = path.resolve("tests/e2e/fixtures/evals");
const HEAD = JSON.parse(fs.readFileSync(path.join(FIXTURES, "2026-10-21T08-30-00-000Z_qwen3.5-9b_e2e-head.json"), "utf8")) as { results: { id: string; status: string }[] };
const BASE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "2026-10-20T10-00-00-000Z_qwen3.5-9b_e2e-base.json"), "utf8")) as { results: { id: string; status: string }[] };
const passed = (r: { results: { status: string }[] }) => r.results.filter((x) => x.status === "pass").length;
const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;

async function axe(page: Page, state: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe (${state})`).toEqual([]);
}
async function openEvals(page: Page) {
  await page.goto("/admin/evals"); // no sign-in (D-22)
  await expect(page.getByRole("heading", { level: 1, name: "Evals" })).toBeVisible();
}

test("the evals dashboard shows the latest run from its results file, compared with the saved baseline @cat:evals", async ({ page }) => {
  await openEvals(page);
  const head = passed(HEAD);
  const base = passed(BASE);
  await expect(page.getByText(pct(head, HEAD.results.length), { exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`^${head} of ${HEAD.results.length} cases(?! run)`))).toBeVisible();
  const delta = (head / HEAD.results.length - base / BASE.results.length) * 100;
  await expect(page.getByText(`+${delta.toFixed(1)} pts`).first()).toBeVisible();
  await expect(page.getByText(/1 of 2 met: release blocked/)).toBeVisible();
  await expect(page.getByText("groundedAnswerCorrectness: 0.8 (wanted ≥ 0.85)")).toBeVisible();
  await expect(page.getByText(/Compared with the saved baseline/)).toBeVisible();
  const changes = page.getByRole("region", { name: /Changes since/ });
  await expect(changes.getByRole("button", { name: "LV-UX-901" })).toBeVisible(); // new failure
  await expect(changes.getByRole("button", { name: "LV-INT-901" })).toBeVisible(); // resolved
  const ux = page.getByRole("article", { name: "Response quality" });
  await expect(ux.getByText("0 of 1 case results passed")).toBeVisible();
  await axe(page, "evals overview");
});

test("the latency section shows the run's turn times and stages, and the benchmark against its baseline, from the files (D-24) @cat:evals", async ({ page }) => {
  await openEvals(page);
  const lat = page.getByRole("region", { name: "Latency" });
  type T = { latencyMs: number | null; modelMs: number | null; timing?: { turnModelMs: number | null } };
  const turns = (HEAD as unknown as { results: { turns: T[] }[] }).results.flatMap((r) => r.turns).filter((t) => t.modelMs !== null);
  const sorted = turns.map((t) => t.latencyMs!).sort((a, b) => a - b);
  const p50 = sorted[Math.ceil(sorted.length / 2) - 1];
  const row = lat.getByRole("row", { name: /^Turns that called the model/ });
  await expect(row.getByRole("cell").nth(0)).toHaveText(String(turns.length));
  await expect(row.getByRole("cell").nth(1)).toContainText(`${p50.toLocaleString("en-GB")} ms`);
  await expect(row.getByRole("cell").nth(2)).toHaveText("n < 20");
  const model = turns.map((t) => t.timing!.turnModelMs!).sort((a, b) => a - b)[Math.ceil(turns.length / 2) - 1];
  await expect(lat.getByRole("definition").filter({ hasText: `${model.toLocaleString("en-GB")} ms` }).first()).toBeVisible();
  // The benchmark: the latest file, with changes against the one labelled baseline.
  const bench = JSON.parse(fs.readFileSync(path.join(FIXTURES, "bench/2026-10-21T09-00-00-000Z_bench.json"), "utf8")) as { summary: { phase: string; key: string; p50: number }[] };
  const lookup = bench.summary.find((g) => g.phase === "warm" && g.key === "kind:lookup")!;
  const benchRow = lat.getByRole("row", { name: /^warm lookup/i });
  await expect(benchRow).toContainText(`${lookup.p50.toLocaleString("en-GB")} ms`);
  await expect(benchRow).toContainText("−1,200 ms"); // 3,300 ms in the baseline file
  await expect(lat.getByText(/Changes against .* \(baseline\)/)).toBeVisible();
  await expect(lat.getByRole("row", { name: /^cold cold/i })).toContainText("model load 6,200 ms");
  await axe(page, "latency section");
});

test("the failure explorer filters cases and opens one with its trace, checks and rerun command @cat:evals", async ({ page }) => {
  await openEvals(page);
  const explorer = page.getByRole("region", { name: "Failure explorer" });
  await expect(explorer.getByText(`1 of ${HEAD.results.length} cases shown`)).toBeVisible();
  await expect(explorer.getByRole("row", { name: /LV-UX-901/ }).getByText("new failure")).toBeVisible();
  await explorer.getByLabel("Area").selectOption("reservations");
  await expect(explorer.getByText("No cases match these filters.")).toBeVisible();
  await explorer.getByLabel("Area").selectOption("all");
  await explorer.getByLabel("Status").selectOption("all");
  await expect(explorer.getByText(`${HEAD.results.length} of ${HEAD.results.length} cases shown`)).toBeVisible();
  await explorer.getByLabel("Status").selectOption("failing");
  // D-24: a category filter, and a rerun of every case not passing in this run.
  await explorer.getByLabel("Category").selectOption("booking_intent");
  await expect(explorer.getByText("No cases match these filters.")).toBeVisible();
  await explorer.getByLabel("Category").selectOption("all");
  await expect(explorer.getByRole("button", { name: "Rerun the case not passing" })).toBeEnabled();
  await explorer.getByRole("button", { name: "LV-UX-901" }).click();
  const dialog = page.getByRole("dialog", { name: "LV-UX-901" });
  await expect(dialog.getByText("Why it failed")).toBeVisible();
  await expect(dialog.getByText(/shows the same text twice/).first()).toBeVisible();
  await dialog.getByText("Tool calls and validation").click();
  await expect(dialog.getByText("Retrieved facts (hybrid): faq:booking-window")).toBeVisible();
  await expect(dialog.getByText("npx tsx evals/run.ts --mode live --case LV-UX-901")).toBeVisible();
  await axe(page, "case detail");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("a scripted smoke run started from the page runs the real runner, and its results file is what the page shows @cat:evals", async ({ page, request, server }) => {
  test.setTimeout(150_000);
  await openEvals(page);
  const dir = path.resolve(serverFiles(server.port).evals);
  const before = new Set(fs.readdirSync(dir));
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByText(/^Running$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start run" })).toBeDisabled();
  // One run at a time, also through the API.
  const again = await request.post(`${server.origin}/api/admin/evals/jobs`, { headers: { origin: server.origin, "content-type": "application/json", }, data: { mode: "scripted", suite: "smoke" } });
  expect(again.status()).toBe(409);
  await expect(page.getByRole("button", { name: "View results" })).toBeVisible({ timeout: 120_000 });
  const file = fs.readdirSync(dir).find((f) => !before.has(f) && f.endsWith("_scripted_smoke.json"));
  expect(file, "the runner wrote a results file").toBeTruthy();
  const run = JSON.parse(fs.readFileSync(path.join(dir, file!), "utf8")) as { results: { status: string }[]; meta: { suite: string; mode: string } };
  expect(run.meta).toMatchObject({ mode: "scripted", suite: "smoke" });
  await page.getByRole("button", { name: "View results" }).click();
  await expect(page.getByLabel("Run", { exact: true })).toHaveValue(file!.replace(/\.json$/, ""));
  await expect(page.getByText(new RegExp(`^${passed(run)} of ${run.results.length} cases(?! run)`))).toBeVisible();
  await expect(page.getByText(pct(passed(run), run.results.length), { exact: true })).toBeVisible();
});

test("with no results the page says how to start, instead of showing zeros @cat:evals", async ({ page, server }) => {
  const dir = path.resolve(serverFiles(server.port).evals);
  const hidden = `${dir}-hidden`;
  fs.renameSync(dir, hidden);
  fs.mkdirSync(dir);
  try {
    await openEvals(page);
    await expect(page.getByRole("heading", { name: "No eval runs yet" })).toBeVisible();
    await expect(page.getByText("0.0%")).toHaveCount(0);
    await axe(page, "evals empty");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(hidden, dir);
  }
});
