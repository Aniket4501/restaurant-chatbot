// npm run eval:smoke | eval:full [-- --scripted-only] [-- --label L]
// D-21: one command per suite. Runs the scripted cases (fake model, every case: they take seconds), then the live
// cases (real local model: the smoke list or every case), and writes a report for each, compared with the saved
// baseline. Exit 1 if any step fails; the live step says so plainly when Ollama is not available (nothing is faked).
import { spawnSync } from "node:child_process";

const suite = process.argv[2];
if (suite !== "smoke" && suite !== "full") {
  console.error("usage: tsx scripts/eval-suite.ts smoke|full [--scripted-only] [--label L]");
  process.exit(2);
}
const label = process.argv.includes("--label") ? ["--label", process.argv[process.argv.indexOf("--label") + 1]] : [];
const step = (title: string, args: string[]) => {
  console.log(`\n== ${title}: tsx ${args.join(" ")}`);
  const r = spawnSync("npx", ["tsx", ...args], { stdio: "inherit" });
  return r.status ?? 1;
};
const codes: [string, number][] = [];
codes.push(["scripted run", step("scripted cases (fake model)", ["evals/run.ts", "--mode", "scripted", "--save", ...label])]);
codes.push(["scripted report", step("scripted report", ["scripts/eval-report.ts", "--mode", "scripted"])]);
if (!process.argv.includes("--scripted-only")) {
  const check = spawnSync("npx", ["tsx", "scripts/model-check.ts"], { stdio: "inherit" });
  if (check.status !== 0) {
    console.log("\nlive cases NOT run: the local model is not available (see model:check above). Nothing was scored.");
    codes.push(["live run", 1]);
  } else {
    codes.push(["live run", step(`live cases (${suite})`, ["evals/run.ts", "--mode", "live", "--suite", suite, ...label])]);
    codes.push(["live report", step("live report", ["scripts/eval-report.ts", "--mode", "live"])]);
  }
}
console.log(`\neval:${suite}: ${codes.map(([n, c]) => `${n} ${c === 0 ? "ok" : `FAILED (${c})`}`).join(", ")}`);
process.exit(codes.every(([, c]) => c === 0) ? 0 : 1);
