# Model adapter

How the app talks to language models, and how to change or test that without touching the booking engine. Status: T-11, T-18 and T-20 (prompt v4, 2026-10-20).

## The boundary

The model never decides anything about a booking. It reads one guest message and returns a `Turn`: an intent, any booking fields the guest stated, and for FAQ or smalltalk a short answer citing fact IDs. Code then validates every field, runs availability, checks grounding, and decides what the guest sees (§5.2, §5.7). The booking engine (`lib/booking/*`) imports nothing from `lib/llm` or `lib/kb`.

There are two model interfaces, each with exactly two implementations:

| Interface | File | Implementations | Used for |
| --- | --- | --- | --- |
| `ModelClient` | `lib/llm/client.ts` | `ollamaModel` (`lib/llm/ollama.ts`), `fakeModel` (`lib/llm/fake.ts`) | one chat call per attempt |
| `Embedder` | `lib/kb/embedder.ts` | `ollamaEmbedder`, `fakeEmbedder` | retrieval vectors (D-02) |

No hosted provider exists, and none can be configured. `lib/config.ts` accepts only `http://` URLs on 127.0.0.1, localhost or ::1, and rejects model names ending in `cloud`. The project has no hosted-model SDK dependency (H1, H2).

Configuration: `LLM_PROVIDER` and `EMBED_PROVIDER` are each `ollama` (default) or `fake`. `CHAT_MODEL` defaults to `qwen3.5:9b` and `EMBED_MODEL` to `qwen3-embedding:0.6b`. `OLLAMA_BASE_URL` defaults to `http://127.0.0.1:11434`. `E2E_TEST_MODE=1` requires both providers to be `fake` (D-12).

## ModelClient

```ts
interface ModelClient {
  readonly provider: "ollama" | "fake";
  readonly model: string;
  chat(req: ModelRequest): Promise<RawEnvelope>;
}
type ModelRequest = { messages: ChatMessage[]; format: JSONSchema; attempt: 1 | 2; signal?: AbortSignal };
```

**Input.** `messages` is `[system, user]` from `buildPrompt` (below). On the single corrective retry, the caller appends the bad reply as `assistant` and `CORRECTIVE_MESSAGE` as `user`, with `attempt: 2`. `format` is `TURN_JSON_SCHEMA`, which is `z.toJSONSchema(TurnSchema)`. A unit test pins it to `evals/fixtures/turn.schema.json` (sha256 1305731e…), the grammar the Phase 2 probe validated.

**Output: the raw envelope.** A client resolves with an envelope for any HTTP response, including errors, and doesn't judge it:

```ts
type RawEnvelope = {
  status: number; error: string | null;          // HTTP status; error body text on non-2xx
  content: string; done_reason: string | null; thinking: string | null;
  prompt_eval_count: number | null; prompt_eval_cached_count: number | null; eval_count: number | null;
  total_ms: number | null;                        // Ollama durations are nanoseconds; clients convert to ms
};
```

A client rejects, with `ModelError`, only when there is no HTTP response: connection refused gives `MODEL_UNAVAILABLE`, and an abort or timeout gives `MODEL_TIMEOUT`.

**Interpretation.** `interpretEnvelope(env, numCtx)` is the only place that decides whether a reply is usable. Both clients go through it, so tests of the fake exercise the production checks. The checks run in this order:

| Check | Result |
| --- | --- |
| HTTP 404 | `MODEL_NOT_PULLED`, mapped by status, never by message text (D-05) |
| HTTP 400 (e.g. "invalid structured output grammar") | `MODEL_INVALID_OUTPUT` |
| Any other non-2xx | `MODEL_UNAVAILABLE` |
| `prompt_eval_count ≥ num_ctx − 512` (7680) | `CONTEXT_TOO_LARGE`, a backstop for the pre-call character budget |
| Non-empty `thinking` | `MODEL_INVALID_OUTPUT`, recorded as `thinking_present` |
| `done_reason === "length"` | `MODEL_INVALID_OUTPUT` |
| Empty content, content that isn't JSON, or a `TurnSchema` miss | `MODEL_INVALID_OUTPUT` |
| Valid, with a 600-character answer | `ok`, flagged `truncated`; the caller shows the fallback |

**Error codes and what the guest sees.** Every code leads to a safe state and never a crash:
- `MODEL_UNAVAILABLE`, `MODEL_NOT_PULLED`, `MODEL_TIMEOUT`: the degraded reply with booking chips. The draft is unchanged.
- `MODEL_INVALID_OUTPUT`: one corrective retry, then the degraded reply.
- `CONTEXT_TOO_LARGE`: one retry with history trimmed to 2 messages, then the degraded reply.

The messages name the fix ("Is `ollama serve` running?", "`ollama pull qwen3.5:9b`"). They never include guest text.

**Timeouts** (`MODEL` in `lib/config.ts`): 15 s per chat call, so at most 30 s with the retry. The warm-up call gets 120 s. The caller passes `AbortSignal.timeout(MODEL.chatTimeoutMs)`.

**Ollama request (`lib/llm/ollama.ts`, D-05).** `POST /api/chat` with `{ model, messages, stream: false, format, think: false, truncate: false, keep_alive: "30m", options: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 400 } }`. The Modelfile sampling parameters are kept. Thinking is detected in `message.thinking` or inline `<think>` tags. Layer A tests (`tests/unit/llm-ollama.test.ts`) stub `fetch` for the body, ECONNREFUSED, a timeout, HTTP 404, 400 and 500, thinking and a non-JSON body (D-12).

**`npm run model:check`** prints one line per check and exits 1 on a failure. It covers:
- the Ollama version;
- both models pulled and local (no `remote*` fields in `/api/tags` or `/api/show`);
- chat capabilities, thinking control (`thinking.values` must include `false`), runner and model context;
- a schema round-trip with the production prompt, twice (first and warm), with tokens and latency;
- the loaded context (soft on MLX);
- the embedder's dimension and norm;
- retrieval index coverage for the configured database (D-13). Incomplete coverage is a warning, because retrieval falls back to lexical.

**`npm run model:warm`** plants a prefix-cache snapshot at the static-prompt boundary for today (`plantSnapshot`: two requests that share the system prompt and diverge at the first user token, OL-22/23), then warms the embedder. The live eval runner does the same for its cases' date before the first scored turn.

## Embedder

```ts
interface Embedder {
  readonly provider: "ollama" | "fake"; readonly model: string;
  digest(opts?: { signal?: AbortSignal }): Promise<string>;                       // /api/tags digest
  embed(inputs: string[], opts?: { signal?: AbortSignal }): Promise<Float32Array[]>; // unit vectors, input order
}
```

- **Text.** Documents are embedded raw (`docText`, NFKC). Queries are embedded as `Instruct: <task>\nQuery:<text>` (`queryText`). Vectors are keyed by model digest and the content hash of the embedded text, so a re-pulled model or an edited fact is never served stale.
- **Ollama.** `POST /api/embed` with `{ model, input, keep_alive: "30m", truncate: false }`.
- **Errors** (`EmbedError`): `EMBED_UNAVAILABLE` (connection refused or 5xx), `EMBED_NOT_PULLED` (HTTP 404, or the model is missing from `/api/tags`), `EMBED_TIMEOUT`, and `EMBED_INVALID_OUTPUT` (HTTP 400, a body that isn't JSON, the wrong count, non-finite or zero vectors).
- **Fallback.** `retrieveFacts` maps every embedder error, an incomplete index (`index_incomplete`) and a missing embedder (`no_embedder`) to lexical-only retrieval with that reason (AC-16). The whole retrieval has a budget of `MODEL.embedTimeoutMs` (2.5 s).

## Prompt

`buildPrompt(input)` in `lib/llm/prompt.ts` is pure and returns `{ system, user, version: "v4" }`.

- **`system`** is static for the branch-local day: rules, the schema, the branch list, restaurant, branch, hours and exception facts, 8 examples, a 7-line weekday list and the 31-day calendar. A test asserts it is byte-identical for any guest, draft, history, retrieved facts or minute on the same day, so Ollama can reuse the cached prefix (D-05).
- **`user`** holds everything per turn: the current time, the retrieved facts, the draft (booking fields only, never name, phone, email or note), the last 8 messages as one JSON `<history>` block, then `<guest_message>`.
- **v4 vs the probe's v2.** A test diffs v4 against `evals/fixtures/probe-prompt.v2.json` (written by `node scripts/model-probe.mjs --dump-prompt`). The only differences:
  - the role line comes from the restaurant row (D-13), and `restaurant:about` leads the facts;
  - weekly hours facts name their exceptions (D-10);
  - rule 6 also covers `<history>`, and history is one JSON block (D-15);
  - `<` and `>` in guest and client text become ‹ ›;
  - v4 (Phase 7, each from a D2 failure; `docs/EVAL_REPORT.md`):
    - rule 1: asking whether a table is free, or changing the booking being arranged in this chat, is `booking`; `manage_booking` is only for a confirmed booking;
    - rule 2: a weekday on its own is looked up in a new "Weekdays" list (the first date after today for each weekday); "the 28th" is the first calendar date with that day; a day and month beyond the calendar is still written out, so code can explain the 30-day limit; a time is set only from a clock time the guest gives;
    - rule 4: a dish is called vegan, vegetarian, gluten-free or free of an allergen only if the facts say so for that dish.
- **After the model (T-20).** Two deterministic guards in `lib/chat`: a model time is dropped when the guest's latest message has no clock time in it (`statesClockTime`, trace `ignore_field`), and an ambiguity whose candidates all fail validation is asked about with the reason ("Bookings open up to 30 days ahead").
- **Masking.** `lib/llm/redact.ts` runs before retrieval and prompting, on every message whatever its role. Emails become `[email]`. Phones that libphonenumber finds become `[phone]`, as does any other run of 8 or more digits; ISO dates and HH:MM times are kept. The prompt never sees an unmasked number.

## Fakes

**Fake model** (`fakeModel({ script })`). It reads the guest text from the `<guest_message>` fence of the first user message, exactly as the model sees it: masked, with angle brackets neutralised. A script maps that text to one of these:
- a `Turn`;
- `{ raw: Partial<RawEnvelope> }`;
- a directive string;
- an array of the above, one per attempt.

Unknown text gets an `unclear` turn. With `E2E_TEST_MODE=1`, `FAKE_SCRIPT` names a JSON script file. These directives also work inline in the guest text:

| Directive | Simulates |
| --- | --- |
| `#fake:down`, `<<DOWN>>` | connection refused (`MODEL_UNAVAILABLE`) |
| `#fake:timeout` | `MODEL_TIMEOUT` |
| `#fake:not_pulled` | HTTP 404 |
| `#fake:length` | truncated JSON, `done_reason: "length"` |
| `#fake:thinking` | thinking content present |
| `#fake:empty` | empty content |
| `#fake:context` | `prompt_eval_count = num_ctx` |
| `#fake:invalid` | prose instead of JSON, on every attempt |
| `#fake:invalid_once` | prose on attempt 1, a valid reply on the retry |
| `#fake:claim` | an FAQ answer claiming a booking, citing the first retrieved fact |

**Fake embedder** (`fakeEmbedder()`). It replays vectors recorded from the real `qwen3-embedding:0.6b` (`evals/fixtures/embeddings.json`), so hybrid retrieval under test is the real ranking. Text it hasn't seen gets a deterministic hash vector and is listed in `misses`. `#fake:embed_down` and `#fake:embed_timeout` in a query raise the matching error. When eval cases add new guest texts, re-record with Ollama running: `npx tsx scripts/kb-embed-fixture.ts`. Existing vectors are kept while the model digest is unchanged.

## Changing the model

1. `ollama pull <model>` (needs approval: H9). Then set `CHAT_MODEL`, or `EMBED_MODEL` followed by `npm run kb:index`.
2. Run `npm run model:check`: digest, schema round-trip, `num_ctx`, warm latency.
3. Run `npm run verify:release`. The D2 eval at 3 runs per case must meet `evals/thresholds.json`. A new embedder also needs the fixture re-recorded and the golden retrieval lists reviewed (`tests/golden/retrieval-top8.json`).

Nothing outside `lib/llm`, `lib/kb/embedder.ts` and `lib/config.ts` changes.
