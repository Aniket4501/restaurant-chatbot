# Model selection

Status: approved at G2-M (2026-10-19) · Probe: `scripts/model-probe.mjs` (MASTER_PROMPT §8 Phase 2 step 4).

**Recommendation:** `qwen3.5:9b` (digest `d63f830f28d5…`), with these settings:
- prompt v2, retrieval layout (D-02), embedder `qwen3-embedding:0.6b` (digest `ac6da0dfba84…`);
- Ollama's default sampling plus §5.8's options: `temperature 0`, `think: false`, `num_ctx 8192`, `num_predict 400`.

It meets every §8 selection floor in the recorded run. `qwen3.5:4b` misses the extraction floor (67% vs 85%), and it produced unsupported "tables are available" claims. Latency is the risk: 9b's warm p95 was 2.82 s, 3.79 s and 4.67 s across three runs as background load on this Mac grew. The third run used the 0–999 grammar; its outputs matched the others on 31 of 32 messages.

## Selection rule results

Proposed configuration: run `2026-10-19T15-03-21-989Z_probe.json`, 32 messages (20 tuning + 12 held-out), clock advanced per call so that cache reuse is realistic.

| Criterion (§8 Phase 2, D-05) | Floor | qwen3.5:9b | qwen3.5:4b |
| --- | --- | --- | --- |
| Intent accuracy | ≥ 90% | **100%** (32/32) | 90.6% (29/32) |
| Booking field extraction, all fields exact | ≥ 85% | **88.9%** (16/18) | 66.7% (12/18) ✗ |
| First-try schema validity | ≥ 95% | **100%** | 100% |
| Warm turn p95 (retrieval + model) | ≤ 4 s | **3.79 s** (other runs 2.82 s, and 4.67 s on the 0–999 grammar) | 5.08 s ✗ (earlier run 2.74 s) |
| GPU share | 100% | 100% | 100% |
| Available system memory in this configuration (replaces GPU, D-05) | ≥ 2 GiB | 3.19 GiB (lowest in any run: 2.25 GiB) | 7.31 GiB |
| FAQ citations correct | — | 10/10 | 10/10 |
| FAQ answers grounded and correct | — | 8/10 (F04, HF4: hours errors → D-10) | 8/10 |
| Injection resistance / off-topic | — | 2/2 / 2/2 | 2/2 / 2/2 |
| Booking or availability claims in answers | 0 | 0 | 4 answers on 2 messages (→ D-11) |

On the D-06 grammar (partySize 0–999, run `…15-17-13-386Z`), 9b's accuracy is identical: 16/18, 32/32, 10/10. Only 1 of 32 outputs differs, in wording (F02). Fixture `evals/fixtures/experiments/turn.schema.partySize-0-999.json` has file sha256 `1305731e…`; the base fixture's is `c42ef47f…`.

## Runs

| Run (in `evals/results/`) | Prompt | Conditions | Messages × runs | Purpose |
| --- | --- | --- | --- | --- |
| `2026-10-19T14-36-59-733Z_probe.json` | v1 | retrieval/tuned, retrieval/modelfile, all-facts/tuned, edge 1–99, edge 0–999 | 20 × 3 (+ 3 edge × 3) | Baseline, penalty A/B, layout, partySize bounds |
| `2026-10-19T14-49-11-215Z_probe.json` | v2 | retrieval and all-facts × modelfile and tuned | 32 × 1 | Prompt fix, held-out check |
| `2026-10-19T15-03-21-989Z_probe.json` | v2, clock varied | retrieval/modelfile, all-facts/modelfile | 32 × 1 | Realistic latency and memory |
| `2026-10-19T15-17-13-386Z_probe.json` | v2, clock varied | retrieval/modelfile on the 0–999 schema (9b only) | 32 × 1 | D-06 grammar on the full set (review T3) |

There are also two partial logs (`*.partial.jsonl`, gitignored). `14-47-49` was stopped after 12 calls to change conditions. `14-57-27` made 128 calls, then crashed in its final selection step; the bug is fixed. Its calls show 9b retrieval p50/p95 of 2.14/2.82 s under lighter load.

v2 used 1 run per condition because v1 showed greedy decoding is repeatable: 9b gave identical outputs across 3 runs for 20/20 messages (retrieval) and 19/20 (all-facts). At temperature 0 the seed has no effect (OL-21). Repeatability is re-measured in the Phase 6 baseline (3 runs).

## What changed between prompt v1 and v2

v1's 9b misses came from two patterns:
- A branch the guest didn't give was treated as ambiguous, and the date the guest did give was dropped (B04, B09).
- Weekday words were mapped to wrong dates (B02 "this Sunday" → 22 Oct; B05 "next Friday" → 23 Oct and 6 Nov).

v2 changes rules only, with no new examples:
- A field the guest didn't mention is null and never ambiguous.
- A weekday means the first calendar date after today with that weekday.
- "Next Friday" means the coming one or the one after.
- Hours facts read "closed for lunch".

Results:
- 9b extraction on the tuning messages went from 6/10 to 9/10.
- On 8 held-out booking messages written before any v2 run, 9b scored 7/8 and 4b 6/8.
- The remaining 9b misses: B02 invents `time 19:00` for "evening"; H05 maps "the 28th" to 4 Nov.

## Retrieval (D-02)

30 labelled queries, mostly paraphrases ("sit outside", "no onion or garlic").

| Mode | hit@8 | recall@8 | MRR | Misses |
| --- | --- | --- | --- | --- |
| Lexical (FTS5) | 0.867 | 0.828 | 0.852 | R18 seafood, R19 not spicy for kids, R21 sit outside, R28 what to wear |
| Semantic (`qwen3-embedding:0.6b`, 1024-dim, normalised) | 1.000 | 0.936 | 0.939 | — |
| Hybrid (RRF, k = 60) | **1.000** | **0.947** | 0.930 | — |

Query embedding takes 16 ms at p50 when warm, and retrieval per turn 24–58 ms at p50. The proposed AC-15 floors (D-13): hybrid hit@8 = 100% and recall@8 ≥ 0.90 in D2, with golden top-8 lists in Layer A.

## Layout: retrieval vs all facts in the prompt (9b, prompt v2)

| | Retrieval (proposed) | All facts |
| --- | --- | --- |
| Extraction | 16/18 | 17/18 |
| Grounded FAQ answers | 8/10 | 9/10 |
| Prompt tokens (static part cached) | 3,530 | 6,506 |
| Uncached tokens per turn | ~468 | ~78 |
| Turn p50 / p95, quieter run (`14-57-27`) | 2.14 / 2.82 s | 1.45 / 1.99 s |
| Turn p50 / p95, busier run (`15-03-21`) | 2.83 / 3.79 s | 1.62 / 4.37 s |
| 9b resident size | 10.4–12.5 GiB | 13.6–15.4 GiB |

Resident size depends partly on run order: MLX prefix snapshots accumulate within a session, and all-facts ran later in each session.

Retrieval is recommended for two reasons: it is what was approved at G1 (D-02), and it keeps 9b about 3 GiB smaller on a 24 GB Mac that is already swapping. All facts in the prompt is the fallback if latency must win; at this menu size, it is about as accurate.

## Settings measured

- **Presence-penalty override (D-05): rejected.** It never improved extraction. 9b: 18/30 with and without it in v1, 15/18 vs 16/18 in v2 retrieval, 16/18 vs 17/18 in v2 all-facts. 4b: 15/30 vs 21/30 in v1.
- **partySize bounds (D-06).** "Table for 150" gave 150 on 0–999, 3/3. On 1–99 it gave 15, 3/3, twice with invented candidates 15–18. There were no length stalls on 9b.
- **Thinking:** absent in every call with `think: false`. No call hit `done_reason: "length"`, and none exceeded the 15 s production timeout.

## Resources and limitations

- **Machine:** Apple M4 Pro, 24 GB unified memory, Ollama 0.40.5 (MLX runner for qwen3.5, llama.cpp for the embedder), Node 26.12.0. Chrome was open for every run. During the later runs another project's Playwright suite and two long-running Next.js dev servers were active; swap use reached 29–30 GB, which explains the rising latency.
- **Demo prep:** close other dev servers and test runs, restart Ollama to reset MLX snapshot memory, then run `npm run model:warm`.
- **Cold first call:** 12.6–14.3 s for 9b (load 2.9–3.9 s plus a full prefill of the static prompt and the embedder load). `model:warm` exists for this.
- **Memory:** 9b was 10.4–12.5 GiB resident in retrieval conditions and up to 15.4 GiB late in long sessions; the embedder adds 1.15 GiB. The lowest available memory was 3.19 GiB in the proposed configuration's run and 2.25 GiB in any run (9b, all-facts). MLX snapshot memory grows with distinct prompts, up to a fixed 8 GiB cap (OL-24).
- **Sample size:** 18 booking and 10 FAQ messages in one run. Floors are re-checked in the Phase 6 baseline: about 60 cases × 3 runs, with phrasings not seen during prompt work.
- **Hours answers:** wrong for exception dates and closed services on both models (HF4, F04). D-10 renders hours answers from facts instead of model prose.
- **Latency target:** p95 ≤ 4 s is met under light-to-moderate load, not under heavy background load. AC-12 treats it as a target, and Phase 6 re-measures under demo conditions.

## Reproduce

Runs before 15:17 used the 1–99 grammar. To reproduce them exactly, copy `evals/fixtures/experiments/turn.schema.partySize-1-99.json` over `evals/fixtures/turn.schema.json` first.

```bash
node scripts/model-probe.mjs --prompt v1 --models qwen3.5:9b,qwen3.5:4b --runs 3                       # v1 (default conditions)
node scripts/model-probe.mjs --prompt v2 --sets chat,heldout --runs 1 \
  --conditions retrieval/modelfile,retrieval/tuned,all-facts/modelfile,all-facts/tuned               # v2
node scripts/model-probe.mjs --prompt v2 --vary-now --sets chat,heldout --runs 1 \
  --conditions retrieval/modelfile,all-facts/modelfile                                               # latency
node scripts/model-probe.mjs --prompt v2 --vary-now --sets chat,heldout --runs 1 \
  --conditions retrieval/modelfile-wide --models qwen3.5:9b                                          # D-06 grammar
node scripts/claims-rescore.mjs evals/results/2026-10-19T14-36-59-733Z_probe.json evals/results/2026-10-19T14-49-11-215Z_probe.json
```
