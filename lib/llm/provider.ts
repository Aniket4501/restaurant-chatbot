import type { AppConfig } from "@/lib/config";
import type { ModelClient } from "@/lib/llm/client";
import { fakeModel, loadFakeScript } from "@/lib/llm/fake";
import { ollamaModel } from "@/lib/llm/ollama";

/** The live chat client exists (T-18), so `npm run eval` (live) may run. */
export const OLLAMA_CHAT_READY = true;

/**
 * The configured chat model: exactly one of the two implementations (§5.2). `fake` replays FAKE_SCRIPT (honoured only
 * in test mode, D-12) and otherwise answers "unclear"; `ollama` is the local Ollama server (lib/llm/ollama.ts).
 */
export function modelFor(config: AppConfig): ModelClient {
  if (config.llmProvider === "fake") return fakeModel({ script: config.test?.fakeScript ? loadFakeScript(config.test.fakeScript) : {} });
  return ollamaModel({ baseUrl: config.ollamaBaseUrl, model: config.chatModel });
}
