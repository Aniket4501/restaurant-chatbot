# Eval run 2026-10-20T20-53-01-862Z_scripted_baseline

- Mode: scripted, suite: full, status: complete
- Code: 56297b8; prompt v5, chooser c5; dataset 0778e20fa218c398
- Model: fake-sequence, temperature 0, seed 42, ctx 8192; load average at the end 9.5
- Started 2026-10-20T20:53:01.862Z, took 1 s
- Cases: 75 of 75 run; 73 passed, 2 failed, 0 flaky, 0 errored, 0 not run
- Critical: 0 invariant violations, 0 false confirmations, 0 duplicate bookings, 1 critical cases not passing

## Release gates

Scripted runs gate on every case passing with no invariant violations.

## Quality areas

| Area | Cases passed | Change |
|---|---|---|
| Input normalization | 0.0% (n 1) | – |
| Intent and entities | 100.0% (n 10) | – |
| Retrieval and grounding | 100.0% (n 5) | – |
| Recommendations | 100.0% (n 16) | – |
| Conversation and follow-ups | 100.0% (n 2) | – |
| Reservations | 100.0% (n 22) | – |
| Safety and policy | 100.0% (n 1) | – |
| Response quality | n/a (n 0) | – |
| Reliability and recovery | 94.4% (n 18) | – |

### Metrics by area

| Area | Metric | Value | Before | Definition |
|---|---|---|---|---|
| Input normalization | Same intent as the clean wording | n/a (n 0) | – | Noisy variants whose first-turn intent matches their clean case's in the same run (pairs where both ran). |
| Intent and entities | Intent accuracy | 100.0% (n 2) | – | Intent checks passed, over every case that states an expected intent (all areas). |
| Intent and entities | Booking-field accuracy | 100.0% (n 19) | – | Booking-state checks (branch, date, time, party size) passed, over every case that states them. |
| Retrieval and grounding | Grounded answer checks | 100.0% (n 8) | – | Citation and required/forbidden fact checks passed, and known facts answered rather than abstained. |
| Retrieval and grounding | Abstains on unknown facts | 100.0% (n 1) | – | Questions with no answer in the facts that got the fallback, not an invented answer. |
| Retrieval and grounding | Unsupported claims shown | 0 (over 100) | – | INV-04 (booking claim without a saved row) and INV-05 (a number not in the cited facts) violations, over the turns run. |
| Recommendations | All recommendation checks | 100.0% (n 44) | – | Every dish-card check (constraints, lead dish, shown or withheld, follow-ups); runs before D-21 recorded only this total. |
| Recommendations | Stated constraints met | 100.0% (n 13) | – | Turns whose shown dishes all meet the stated diet, allergen, budget and course (and none of the excluded dishes). |
| Recommendations | Acceptable lead dish | 100.0% (n 7) | – | Turns whose lead dish is one of the defensible answers listed by the case. |
| Recommendations | Card shown or withheld correctly | 100.0% (n 22) | – | A dish card shown when one fits, and none for an impossible request. |
| Recommendations | Cheaper / different follow-ups | 100.0% (n 2) | – | 'Cheaper' leads are cheaper and 'another' leads differ from the earlier turn's. |
| Conversation and follow-ups | Multi-turn cases completed | 100.0% (n 17) | – | Cases with two or more guest turns (any area) that passed every check. |
| Reservations | Offered times really open | 100.0% (n 113) | – | Times shown to the guest that the availability engine had open at that moment (INV-03). |
| Reservations | Submit outcomes as expected | 100.0% (n 16) | – | Reservation submits that returned the expected HTTP status and error code. |
| Reservations | False confirmations | 0 (over 100) | – | A confirmation without a matching saved row (INV-01) or booking-claim text without a create (INV-04). |
| Reservations | Duplicate bookings | 0 (over 75) | – | Duplicate confirmed rows for one booking (INV-02). |
| Safety and policy | Injection cases passed | 100.0% (n 1) | – | Prompt-injection cases (forged history, instructions in guest text) that passed. |
| Safety and policy | Allergen, diet and policy cases passed | n/a (n 0) | – | Safety cases: no unsupported allergen or diet claim, no invented policy, no prompt or reasoning disclosure. |
| Response quality | Replies without repeated text | 99.1% (n 115) | – | Turns where no text is shown twice (reply and notice, or a repeated sentence), over every turn run. |
| Response quality | Replies without IDs, JSON or internal wording | 100.0% (n 345) | – | Turn checks for fact IDs, JSON, prompt tags and internal list wording shown to the guest (three checks per turn). |
| Reliability and recovery | Cases that could not run | 0.0% (n 75) | – | Case results with an execution error (setup or harness), not a failed expectation. |
| Reliability and recovery | Model turns degraded | 8.5% (n 82) | – | Turns that called the model and fell back to the degraded reply (down, timeout, invalid output), including deliberate fault cases. |
| Reliability and recovery | Model timeouts | 1 (over 82) | – | Model calls that timed out, over the turns that called the model (traces from D-21 runs only). |
| Reliability and recovery | Turn latency p50 | 4 ms (n 82) | – | Median end-to-end turn time over turns that called the model. |
| Reliability and recovery | Turn latency p95 | 7 ms (n 82) | – | 95th percentile turn time (shown from 20 turns up). |

## Comparison

No earlier comparable run or baseline was given.

## Cases not passing (2)

### SC-BACK-004 (backend_failure, critical, fail)

- turn 1: shows the same text twice: "sorry, i couldn't check availability just now, so i can't sh"

Rerun: `npx tsx evals/run.ts --mode scripted --case SC-BACK-004`

### SC-NORM-001 (normalization, major, fail)

- unexpected model call: fake model: modelScript has no reply left for this call

Rerun: `npx tsx evals/run.ts --mode scripted --case SC-NORM-001`

