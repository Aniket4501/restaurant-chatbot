import type { ApiDeps } from "@/lib/api/deps";
import { noTurnLimit, openGate, type ModelGate, type TurnLimiter } from "@/lib/chat/ratelimit";
import { fakeEmbedder, type Embedder } from "@/lib/kb/embedder";
import type { ModelClient } from "@/lib/llm/client";
import { fakeModel, type FakeScript } from "@/lib/llm/fake";

/** Chat dependencies for handler tests: the scripted model, the fixture embedder, no limits unless given. */
export function testChatDeps(o: { script?: FakeScript; model?: ModelClient; embedder?: Embedder | null; limiter?: TurnLimiter; gate?: ModelGate } = {}): ApiDeps["chat"] {
  const model = o.model ?? fakeModel({ script: o.script ?? {} });
  const embedder = o.embedder === undefined ? fakeEmbedder() : o.embedder;
  return { model: () => model, embedder: () => embedder, limiter: o.limiter ?? noTurnLimit, gate: o.gate ?? openGate };
}
