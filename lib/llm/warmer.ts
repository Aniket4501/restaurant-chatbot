import { defaultDeps } from "@/lib/api/deps";
import type { ModelGate } from "@/lib/chat/ratelimit";
import { getConfig, MODEL } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { currentJob } from "@/lib/evals/jobs";
import { warmModel, type Run } from "@/lib/llm/warm";
import { getNow } from "@/lib/time/now";
import { resultsDir } from "@/evals/paths";
import { listRuns } from "@/evals/report";

// D-23: the server warms the local model when it starts and every 15 minutes, so the model stays loaded (each call
// renews Ollama's 30-minute keep-alive) and the turn and chooser prompt prefixes stay cached, including after midnight
// when the date in the prompt changes. Each step waits its turn in the guest model gate, so it never runs alongside a
// guest's model call; a full queue skips the round. An eval run in progress (from the dashboard or the command line)
// also skips it: it keeps the model loaded itself, and a warm-up would slow its cases. Not in test mode and not with
// the fake model.
let started = false;

export type WarmRound = { gate: ModelGate; evalRunning: () => boolean; warm: (run: Run) => Promise<unknown> };

/** One round: skipped while an eval runs; otherwise every step through the gate. */
export async function warmRound(r: WarmRound): Promise<"warmed" | "eval running"> {
  if (r.evalRunning()) return "eval running";
  await r.warm((fn) => r.gate.run(fn));
  return "warmed";
}

const evalRunning = () => currentJob()?.state === "running" || listRuns(resultsDir()).some((x) => x.summary.status === "running");

export function startWarmer(): void {
  const config = getConfig();
  if (started || config.testMode || config.llmProvider !== "ollama") return;
  started = true;
  const once = async () => {
    try {
      let shots: Awaited<ReturnType<typeof warmModel>> | null = null;
      const outcome = await warmRound({ gate: defaultDeps().chat.gate, evalRunning, warm: async (run) => (shots = await warmModel(getDb(), getNow(), run)) });
      const r = shots as Awaited<ReturnType<typeof warmModel>> | null;
      if (!r) console.info(JSON.stringify({ event: "model_warm_skipped", reason: outcome }));
      else console.info(JSON.stringify({ event: "model_warm", chatMs: r.chat.reduce((n, x) => n + x.ms, 0), chatCached: r.chat.at(-1)?.cached ?? null, chooserMs: r.chooser.reduce((n, x) => n + x.ms, 0), embedMs: r.embedMs }));
    } catch (e) {
      console.warn(JSON.stringify({ event: "model_warm_skipped", reason: (e as Error).message }));
    }
  };
  setTimeout(once, 1_000);
  setInterval(once, MODEL.rewarmEveryMs).unref();
}
