import { getConfig } from "@/lib/config";
import { closeDb, getDb } from "@/lib/db/client";
import { warmModel } from "@/lib/llm/warm";
import { getNow } from "@/lib/time/now";

// npm run model:warm (§5.8, D-05): load the chat model, plant prefix-cache snapshots of both static prompts, warm the
// embedder. The running server also does this when it starts and every 15 minutes (lib/llm/warmer.ts, D-23).
const config = getConfig();
try {
  const r = await warmModel(getDb(), getNow());
  r.chat.forEach((x, i) => console.log(`chat ${config.chatModel} snapshot ${i + 1}/2: ${x.ms} ms, prompt ${x.prompt} tokens, ${x.cached ?? 0} cached`));
  r.chooser.forEach((x, i) => console.log(`chooser snapshot ${i + 1}/2: ${x.ms} ms, prompt ${x.prompt} tokens, ${x.cached ?? 0} cached`));
  console.log(r.embedMs === null ? "embedder: not used (EMBED_PROVIDER=fake)" : `embedder ${config.embedModel}: ${r.embedMs} ms`);
} catch (e) {
  console.error(`model:warm failed: ${(e as Error).message}`);
  process.exit(1);
} finally {
  closeDb();
}
