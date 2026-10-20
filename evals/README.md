# Evals

How the chatbot is tested beyond unit tests: version-controlled cases run through the real pipeline (`runTurn`, the
availability engine, the reservation API and its database writes), scored by deterministic checks and invariants, and
kept as results files that reports and the staff dashboard (`/admin/evals`) read. Decisions: D-12 (the harness), D-20
(recommendations), D-21 (areas, suites, reports, dashboard) in `docs/DECISIONS.md`.

## Layers

| Layer | What | Where | Command |
|---|---|---|---|
| 1. Deterministic units | normalization helpers, schemas, guards, eligibility, validation of the model's choices, booking state, dedupe, report maths | `tests/unit` | `npm run test:unit` |
| 2. Retrieval and grounding | hit@8 / recall@8 on 30 labelled queries; citations, prices, hours and forbidden facts per case | `evals/fixtures/probe-messages.json`, case expectations | part of `eval` (live) |
| 3. Model behaviour | the local model through the real pipeline: intents, fields, answers, recommendations, conversations | `evals/cases/live-*.jsonl` | `npm run eval:smoke`, `npm run eval:full` |
| 4. Integration | API handlers, turns, migrations, concurrency, the evals API | `tests/integration` | `npm run test:integration` |
| 5. End to end | the browser UI on a test-mode server, booking persistence, admin, the evals dashboard, axe | `tests/e2e` | `npm run test:e2e` |
| 6. Human review | a sample of recommendations, clarifications, no-match replies, noisy input and safety answers per run | `evals/reports/<run>-review.md` | `npm run eval:report` |

Scripted cases (`evals/cases/scripted-*.jsonl`) replace the model with exact scripted replies, so they test what the
app does with a given model output (faults, invalid output, validation and fallbacks) in seconds. Live cases call the
local Ollama model with temperature 0 and a fixed seed; no hosted model is used, and no model judges another: the
only local model is the one under test, so subjective quality goes to the human-review sample.

## Cases

One JSON object per line; the schema is `evals/case.ts` (unknown keys are errors). Each case has a stable ID, a
category (grouped into nine quality areas by `evals/areas.ts`), a severity, a fixed `now` and the fixture
`evals/fixtures/base.json`, the turns (guest text, chip actions, submits, simulated reloads, another guest's booking),
and expectations: exact values for structured output (intent, booking fields, citations, prices, times, reservations
created, HTTP statuses) and behavioural checks for free text (facts that must or must not appear, regexes, a reply
length limit, dish-card constraints that accept every defensible dish). `variantOf` marks a noisy rewording of another
case (typos, Hinglish, Unicode); the report checks the two are understood the same way. Every run also applies the
invariants (`evals/invariants.ts`: no confirmation without a saved row, no double booking, only open times offered, no
unsupported claims) and response-shape checks (no fact IDs, JSON or internal wording shown; no text shown twice).

A new guest text in a scripted case needs a recorded embedding: `npx tsx scripts/kb-embed-fixture.ts` (Ollama).

## Commands

```bash
npm run eval:scripted                       # every scripted case (fake model), seconds; part of npm run verify
npm run eval:smoke                          # scripted cases, then the live smoke list (evals/suites.json), with reports
npm run eval:full                           # scripted cases, then every live case (about an hour on an M4 Pro), with reports
npm run eval:report -- --mode live          # report on the latest finished live run, compared with the baseline
npm run eval:report -- --run <run id> --against previous
npm run eval:report -- --run <run id> --set-baseline "why"   # save a run as the baseline for its mode and suite
npm run verify:release                      # everything, plus the live cases three times with the release gates
```

Debugging one case or area:

```bash
npx tsx evals/run.ts --mode live --case LV-REC-014           # one case (comma-separate several)
npx tsx evals/run.ts --mode live --area recommendations      # one quality area
npx tsx evals/run.ts --mode scripted --category recommendation
```

A failed case is reproducible from its ID: the case file holds the fixture, the fixed clock and the turns, and every
report and the dashboard print the exact rerun command.

## Results, reports and gates

- Live runs, and scripted runs started with `--save` (the suites and the dashboard do), are written to
  `evals/results/<timestamp>_<model>[_smoke][_label].json`: run metadata (commit, uncommitted changes, prompt and chooser
  versions, dataset hash, model digest and settings, machine load), metrics, gate results, and per case its status
  (pass, fail, or error when it could not run), checks, invariant violations, and per turn the reply, cards, tool calls
  and validation results (trace), booking state, retrieved fact IDs and latency. Guest inputs are synthetic and masked.
- While a run is going, `<timestamp>_<mode>.partial.jsonl` holds the finished cases; an interrupted run stays visible as
  interrupted, and its unrun cases are counted as not run, never as passed.
- `evals/report.ts` turns a results file into area summaries with explicit denominators (a rate with no data is shown as
  "no data"; p95 latency from 20 turns up) and compares two runs case by case (new failures, resolved, still failing)
  and metric by metric. `evals/baseline.json` holds the baseline run per mode and suite.
- Release gates are `evals/thresholds.json` (changes need the user's approval): a full live run must have no invariant
  violations, no duplicate bookings, only open times offered, no unsupported claims, full injection resistance,
  recovery and abstention, and intent, field, action, grounding and schema floors. `eval:report` also exits 1 on
  critical failures and on any case that passed in the comparison run and fails now.

## Limits

A finite set of cases is evidence, not proof. Live results vary a little between runs even at temperature 0 (prefix
caching, machine load); the release runs every live case three times and reports flaky cases. Latency on this shared
machine depends on what else is running (the load average is recorded with each run). Subjective quality (is this the
dish a host would suggest?) is judged by people from the review sample, not by an automated score.
