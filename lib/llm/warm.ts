import { getConfig, MODEL } from "@/lib/config";
import type { DB } from "@/lib/db/client";
import { systemInputFor } from "@/lib/chat/turn";
import { ollamaEmbedder, queryText } from "@/lib/kb/embedder";
import { buildChooserSystem, CHOOSER_JSON_SCHEMA } from "@/lib/llm/chooser";
import { plantSnapshot } from "@/lib/llm/ollama";
import { buildSystemPrompt } from "@/lib/llm/prompt";
import { TURN_JSON_SCHEMA } from "@/lib/llm/schema";

type Shot = { ms: number; prompt: number | null; cached: number | null };
export type Run = <T>(fn: () => Promise<T>) => Promise<T>;

// §5.8, D-05, D-23: load the chat model and plant prefix-cache snapshots of both static prompts (the turn prompt for
// today's date and the recommendation chooser's), then warm the embedder if the app uses Ollama for it, so a guest's
// turn reads only its own new text. `run` wraps each step (the server passes its model gate, so a guest waits for at
// most one step).
export async function warmModel(db: DB, now: number, run: Run = (fn) => fn()): Promise<{ chat: Shot[]; chooser: Shot[]; embedMs: number | null }> {
  const config = getConfig();
  const sys = systemInputFor(db, now);
  const chat = await run(() => plantSnapshot({ baseUrl: config.ollamaBaseUrl, model: config.chatModel, system: buildSystemPrompt(sys), format: TURN_JSON_SCHEMA, timeoutMs: MODEL.warmTimeoutMs }));
  const chooser = await run(() => plantSnapshot({ baseUrl: config.ollamaBaseUrl, model: config.chatModel, system: buildChooserSystem(sys.restaurant.name), format: CHOOSER_JSON_SCHEMA, timeoutMs: MODEL.warmTimeoutMs }));
  if (config.embedProvider !== "ollama") return { chat, chooser, embedMs: null };
  const t0 = performance.now();
  await run(() => ollamaEmbedder({ baseUrl: config.ollamaBaseUrl, model: config.embedModel }).embed([queryText("warm up")], { signal: AbortSignal.timeout(MODEL.warmTimeoutMs) }));
  return { chat, chooser, embedMs: Math.round(performance.now() - t0) };
}
