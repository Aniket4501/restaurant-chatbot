import fs from "node:fs";
import { MODEL } from "@/lib/config";
import { ModelError, type ModelClient, type ModelRequest, type RawEnvelope } from "@/lib/llm/client";
import type { Turn } from "@/lib/llm/schema";

// Scripted chat model for tests, evals and the "scripted model" UI mode (§5.8, D-12). It returns the same raw
// envelope as Ollama, so every reply goes through interpretEnvelope like a real one.
//
// The guest text is read from the <guest_message> fence of the request's first user message, exactly as the model
// would see it (masked, with < > neutralised). A script maps that text to:
//   - a Turn object                     → a valid reply
//   - { raw: Partial<RawEnvelope> }     → that envelope (e.g. a 500, or malformed content)
//   - a directive string ("#fake:…")    → as below
//   - an array of the above             → one per attempt (the corrective retry gets the second)
// Directives may also appear inside the guest text itself:
//   #fake:down or <<DOWN>>  connection refused (MODEL_UNAVAILABLE)    #fake:timeout    MODEL_TIMEOUT
//   #fake:not_pulled        HTTP 404                                   #fake:length     done_reason "length"
//   #fake:thinking          thinking content present                   #fake:empty      empty content
//   #fake:context           prompt_eval_count at num_ctx               #fake:invalid    content that is not JSON
//   #fake:invalid_once      not JSON on attempt 1, a valid reply on 2  #fake:claim      an FAQ answer claiming a booking
// Anything else gets an "unclear" turn.

export type FakeReply = Turn | { raw: Partial<RawEnvelope> } | string;
export type FakeScript = Record<string, FakeReply | FakeReply[]>;

const DIRECTIVES = ["#fake:down", "#fake:timeout", "#fake:not_pulled", "#fake:length", "#fake:thinking", "#fake:empty", "#fake:context", "#fake:invalid_once", "#fake:invalid", "#fake:claim"] as const;

export const nullBooking = (): Turn["booking"] => ({ branch: null, date: null, time: null, timeWindow: null, partySize: null, ambiguity: null });
export const unclearTurn = (): Turn => ({ intent: "unclear", booking: nullBooking(), answer: null, citedFactIds: [], answerable: true });

/** The guest text the model sees: the last <guest_message> in the first user message. */
export function guestTextOf(req: ModelRequest): string {
  const user = req.messages.find((m) => m.role === "user")?.content ?? "";
  const all = [...user.matchAll(/<guest_message>([\s\S]*?)<\/guest_message>/g)];
  return all.at(-1)?.[1] ?? "";
}

/** The fact IDs listed in the request's retrieved-facts block ("ID | fact" lines). */
function retrievedIds(req: ModelRequest): string[] {
  const user = req.messages.find((m) => m.role === "user")?.content ?? "";
  return [...user.matchAll(/^([a-z][a-z-]*:[^\s|]+) \| /gm)].map((m) => m[1]);
}

export function loadFakeScript(file: string): FakeScript {
  return JSON.parse(fs.readFileSync(file, "utf8")) as FakeScript;
}

/** Replies in call order, one per model call including retries (the eval case `modelScript`, §6.3). */
export function sequenceModel(replies: FakeReply[], opts: { model?: string } = {}): ModelClient & { remaining: () => number } {
  const queue = [...replies];
  const inner = fakeModel({ model: opts.model ?? "fake-sequence" });
  return {
    provider: "fake",
    model: opts.model ?? "fake-sequence",
    remaining: () => queue.length,
    async chat(req) {
      if (!queue.length) throw new Error("fake model: modelScript has no reply left for this call");
      return inner.chat({ ...req, messages: req.messages }, queue.shift());
    },
  };
}

export function fakeModel(opts: { script?: FakeScript; model?: string } = {}): ModelClient & { chat(req: ModelRequest, forced?: FakeReply): Promise<RawEnvelope> } {
  const script = opts.script ?? {};
  return {
    provider: "fake",
    model: opts.model ?? "fake-scripted",
    async chat(req: ModelRequest, forced?: FakeReply) {
      const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
      const envelope = (over: Partial<RawEnvelope>): RawEnvelope => ({
        status: 200,
        error: null,
        content: "",
        done_reason: "stop",
        thinking: null,
        prompt_eval_count: Math.ceil(promptChars / 3), // the probe measured ≈3 characters per token
        prompt_eval_cached_count: 0,
        eval_count: null,
        total_ms: 0,
        ...over,
      });
      const ofTurn = (t: Turn) => {
        const content = JSON.stringify(t);
        return envelope({ content, eval_count: Math.ceil(content.length / 3) });
      };
      const directive = (d: string): RawEnvelope => {
        switch (d) {
          case "#fake:down":
            throw new ModelError("MODEL_UNAVAILABLE", "fake model: connection refused (#fake:down)");
          case "#fake:timeout":
            throw new ModelError("MODEL_TIMEOUT", "fake model: timeout (#fake:timeout)");
          case "#fake:not_pulled":
            return envelope({ status: 404, error: "model not found", prompt_eval_count: null });
          case "#fake:length":
            return envelope({ content: '{"intent":"faq","booking":{"branch":null', done_reason: "length" });
          case "#fake:thinking":
            return { ...ofTurn(unclearTurn()), thinking: "Let me think about this." };
          case "#fake:empty":
            return envelope({ content: "" });
          case "#fake:context":
            return envelope({ prompt_eval_count: MODEL.numCtx, content: JSON.stringify(unclearTurn()) });
          case "#fake:invalid":
            return envelope({ content: "Sure! Here is your answer." });
          case "#fake:invalid_once":
            return req.attempt === 1 ? envelope({ content: "Sure! Here is your answer." }) : ofTurn(unclearTurn());
          case "#fake:claim": {
            const cited = retrievedIds(req).slice(0, 1);
            return ofTurn({ intent: "faq", booking: nullBooking(), answer: "Good news, I've booked your table for tonight.", citedFactIds: cited, answerable: true });
          }
          default:
            throw new Error(`fake model: unknown directive ${d}`);
        }
      };
      const reply = (r: FakeReply): RawEnvelope => (typeof r === "string" ? directive(r) : "raw" in r ? envelope(r.raw) : ofTurn(r));

      if (forced !== undefined) return reply(forced);
      const guest = guestTextOf(req);
      if (/[<‹]{2}DOWN[>›]{2}/.test(guest)) return directive("#fake:down");
      const inline = DIRECTIVES.find((d) => guest.includes(d));
      if (inline) return directive(inline);
      const scripted = script[guest];
      if (scripted !== undefined) return reply(Array.isArray(scripted) ? (scripted[req.attempt - 1] ?? scripted.at(-1)!) : scripted);
      return ofTurn(unclearTurn());
    },
  };
}
