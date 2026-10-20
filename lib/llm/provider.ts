import type { AppConfig } from "@/lib/config";
import { ModelError, type ModelClient } from "@/lib/llm/client";
import { fakeModel, loadFakeScript } from "@/lib/llm/fake";

/** False until T-18 wires lib/llm/ollama.ts; `npm run eval` (live) refuses to run while false. */
export const OLLAMA_CHAT_READY = false;

/**
 * The configured chat model. `fake` replays FAKE_SCRIPT (honoured only in test mode, D-12) and otherwise answers
 * "unclear". `ollama` is wired in T-18 (lib/llm/ollama.ts); until then every call fails as MODEL_UNAVAILABLE, so the
 * app runs in its degraded mode (booking through chips still works) rather than calling anything else.
 */
export function modelFor(config: AppConfig): ModelClient {
  if (config.llmProvider === "fake") return fakeModel({ script: config.test?.fakeScript ? loadFakeScript(config.test.fakeScript) : {} });
  return {
    provider: "ollama",
    model: config.chatModel,
    async chat() {
      throw new ModelError("MODEL_UNAVAILABLE", "The Ollama chat client is not wired yet (T-18).");
    },
  };
}
