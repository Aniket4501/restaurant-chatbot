import { getConfig, MODEL } from "@/lib/config";
import { closeDb, getDb } from "@/lib/db/client";
import { systemInputFor } from "@/lib/chat/turn";
import { ollamaEmbedder, queryText } from "@/lib/kb/embedder";
import { plantSnapshot } from "@/lib/llm/ollama";
import { buildSystemPrompt } from "@/lib/llm/prompt";
import { TURN_JSON_SCHEMA } from "@/lib/llm/schema";
import { getNow } from "@/lib/time/now";

// npm run model:warm (§5.8, D-05): load the chat model and plant a prefix-cache snapshot at the static-prompt
// boundary (plantSnapshot), then warm the embedder, so the first guest turn is fast.
const config = getConfig();
const system = buildSystemPrompt(systemInputFor(getDb(), getNow()));
closeDb();
try {
  const shots = await plantSnapshot({ baseUrl: config.ollamaBaseUrl, model: config.chatModel, system, format: TURN_JSON_SCHEMA, timeoutMs: MODEL.warmTimeoutMs });
  shots.forEach((x, i) => console.log(`chat ${config.chatModel} snapshot ${i + 1}/2: ${x.ms} ms, prompt ${x.prompt} tokens, ${x.cached ?? 0} cached`));
} catch (e) {
  console.error(`model:warm failed: ${(e as Error).message}`);
  process.exit(1);
}
const t0 = performance.now();
await ollamaEmbedder({ baseUrl: config.ollamaBaseUrl, model: config.embedModel }).embed([queryText("warm up")], { signal: AbortSignal.timeout(MODEL.warmTimeoutMs) });
console.log(`embedder ${config.embedModel}: ${Math.round(performance.now() - t0)} ms`);
