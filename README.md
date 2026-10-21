# Neem & Ember: restaurant reservation chatbot

A local demo of a restaurant's booking assistant, with two parts:
- **Guest chat:** answers questions about the menu, hours and branches, and books a table.
- **Staff page:** a bookings list for each day.

Everything runs on your machine: Next.js, SQLite and a local model through Ollama. No cloud services and no API keys. Neem & Ember is a fictional restaurant with two branches in Delhi NCR, Hauz Khas and Golf Course Road.

## Quick start

You need:
- Node 26 (developed on 26.12.0);
- Ollama 0.40 or later, running locally;
- the two models, pulled once:

```bash
ollama pull qwen3.5:9b
ollama pull qwen3-embedding:0.6b
```

Then:

```bash
npm install
cp .env.example .env.local     # optional: only to override the defaults
npm run setup                  # migrate and seed data/app.db, index the menu and FAQ facts, check the model
npm run model:warm             # optional: the server also warms the model when it starts
npm run dev                    # http://127.0.0.1:3000 for guests, http://127.0.0.1:3000/admin for staff
```

The app listens on 127.0.0.1 only. The staff pages have no password (anyone using this computer can open them); other websites still can't change anything, since every change must come from the app's own pages. To start from fresh demo data, run `npm run db:reset && npm run kb:index`. This rebuilds `data/app.db`, deleting any bookings made so far, and re-indexes the facts; without `kb:index`, retrieval falls back to keyword search.

## What you can do

**Guests** (`/`):
- Ask a question, for example "Do you have parking at Hauz Khas?" or "How much is the butter chicken?". Unknown or unrelated questions get a short fallback with the branch phone number.
- Ask for a suggestion in your own words: "the best vegetarian dish under ₹400", "something light", "surprise me". Then refine it: "anything cheaper?", "another option", "actually, a dessert instead". Preferences, including an allergy, carry over until you change them, even across a booking. The buttons ("Help me find a dish", "Something cheaper", "Opening hours"…) skip the step that works out what a typed message means, so they answer sooner.
- Browse the menu by section, or ask for "the vegan dishes".
- Tap **Book a table**, then choose a branch, date, party size and one of the open times. Enter your name and mobile number, then tap Confirm.
- You can also type a request, for example "table for 2 tomorrow at 8pm at Golf Course Road".

The booking reference appears only after the booking has been saved. Full times, invalid party sizes (online booking is for 1 to 8 guests), past dates and dates more than 30 days ahead are explained, with alternatives where there are any.

**Staff** (`/admin`, no sign-in): pick a date (it opens on today) and optionally a branch. You see the day's booking and guest counts and a table of each booking's time, guest, party size, branch and status. Cancelling a booking frees its table straight away.

**Evals** (`/admin/evals`, no sign-in): how the chatbot scores on its test cases. Start a scripted or live run (smoke or full, optionally one quality area), follow its progress, compare any run with the saved baseline or another run, see quality by area with each metric's definition and case count, trends across runs, new failures and resolved cases, and the Latency section: turn time by kind of turn (p50, and p95 from 20 turns), where a model turn's time goes, and the latest benchmark against the one labelled baseline. Filter the failing cases by area, category, severity or failure type, rerun the ones not passing, and open any case to see each turn's input, reply, timing, tool calls, validation results and checks, with the command that reruns it. Every number comes from the results files in `evals/results`; see `evals/README.md`.

## How it works

```
guest message ──► mask phone and email ──► retrieve facts (SQLite FTS5 + embeddings)
              ──► model call 1, JSON: intent, booking fields, food preferences, FAQ answer with cited fact IDs
              ──► code checks everything ──► reply

recommendation ──► code filters the menu by the stated constraints ──► model call 2 picks a dish and says why
               ──► code validates the pick (one retry, then options) ──► dish card from the menu table

booking fields ──► validate ──► availability engine ──► open times ──► confirm card ──► POST /api/reservations
```

- **Recommendations: the model chooses, code checks.**
  - The first model call understands the request and your active preferences (diet, budget, course, spice, allergies, "cheaper", "another").
  - Code keeps those preferences honest: what your words state for certain is always added, a constraint stays in force until you lift it ("I'm not vegetarian", "price doesn't matter"), and the model can't invent a budget or "mild".
  - An allergy the menu labels don't cover (they cover nuts, dairy, egg and gluten) gets a referral to staff instead of a dish.
  - Code narrows the menu to the dishes that meet those constraints, using only verified data. It filters; it never ranks.
  - A second model call compares those dishes, picks one, with up to two alternatives, and says why.
  - Code checks the pick before showing it:
    - it is a real, available dish that meets every stated constraint;
    - each price, and each diet word ("vegan", "no dairy"), is true of the dish it describes;
    - it names no dish that isn't on the card;
    - there are no invented "popular" claims and no safety promises ("safe", "nut-free");
    - there is no booking talk.

    On failure the model gets one retry, then you see a few dishes that fit, presented as options.
  - If nothing fits ("a vegan main under ₹200"), you're told so, with no model call and no substitute.
  - The dish card shows the menu's own name, price, labels, allergens and description, never model text.
- **The model never books and never decides availability.**
  - It classifies the message, extracts booking fields and drafts FAQ answers.
  - Code validates every field and computes open times from the opening hours, date exceptions and table sizes: 30-minute slots, 90- or 120-minute sittings, at least 60 minutes ahead, up to 30 days out.
  - Code decides what the guest sees.
  - Buttons (chips and times) never call the model.
- **Answers come only from stored facts.**
  - An FAQ answer is shown only if it cites facts, every time, price and phone number in it appears in those facts, and it makes no booking claim. Otherwise the guest sees the fallback.
  - Opening hours are written out from the data, not by the model.
  - A few deterministic checks catch common extraction mistakes, for example a time the guest never stated, or a weekday read as the wrong date.
- **Bookings are safe to retry.**
  - Each booking is one SQLite IMMEDIATE transaction, with database triggers that refuse overlapping bookings on a table and overlapping bookings for one mobile number.
  - Submits carry an idempotency key, so a double tap or a reload books once.
- **Code layout:**
  - `lib/booking`: availability and the write path;
  - `lib/chat`: turn routing, grounding and the extraction checks;
  - `lib/llm`: the prompt and the Ollama client;
  - `lib/kb`: facts and retrieval;
  - `components`: the UI;
  - `data/seed`: restaurant data.

Design decisions are recorded in `docs/DECISIONS.md`, and the model interface in `docs/MODEL_ADAPTER.md`.

## Model choice

**Chat model: `qwen3.5:9b` on Ollama**, for both calls: understanding each message, and choosing among the dishes that fit for a recommendation.
- **Settings:** thinking off, temperature 0, output constrained to a JSON schema, 8k context.
- **Why 9b:** it was picked over `qwen3.5:4b` in a measured comparison (`docs/MODEL_SELECTION.md`). The 4b model made unsupported availability claims and missed more booking fields. The 9b model fits comfortably in 24 GB on Apple silicon.
- **Speed:** about 2–3 s per turn once warm.

**Embeddings: `qwen3-embedding:0.6b`.** It powers the semantic half of retrieval. If it is unavailable, retrieval falls back to keyword search.

**If Ollama is down:** the chat says so, and booking still works through the buttons.

Quality is measured on 92 live test conversations, 3 runs each (`docs/EVAL_REPORT.md`):

- 276 of 276 conversation runs passed, with 0 invariant violations: no false booking claims, no double bookings, no unsupported prices or times shown.
- Intent, booking-field extraction, grounded answers, abstention on unknown facts and resistance to prompt injection all scored 1.0.
- Warm reply time was 2.5 s median, 3.9 s p95 for booking turns, and 3.4 s / 5.3 s for questions, measured while other work loaded the machine.

## Tests

```bash
npm run verify           # lint, types, unit, integration, scripted evals (fake model), build, Playwright E2E with axe accessibility checks
npm run eval:smoke       # scripted cases, then a few live cases per quality area (local model), with reports
npm run eval:full        # scripted cases, then every live case (15–25 minutes), with reports compared with the baseline
npm run eval:report      # report on the latest run: evals/reports/<run>.md, .json and -review.md (for human review)
npm run verify:release   # everything, plus the live cases 3 times with the release gates
npx tsx evals/run.ts --mode live --case LV-REC-014   # rerun one case (or --area recommendations)
npm run build && npm run bench -- --label mylabel    # latency benchmark (local model, isolated server on port 3107)
```

The benchmark (`scripts/bench.ts`, scenarios in `evals/bench.json`) starts its own `next start` with a temporary database, so `data/app.db` is untouched. It times warm questions, recommendations, a follow-up, the menu button, a typed booking and the booking flow with its save; a real browser from send to the reply on screen; and cold starts after unloading both models. Results go to `evals/results/bench/` and appear in the Latency section of `/admin/evals`.

The eval cases, layers, metrics, baseline and how to reproduce a failure are described in `evals/README.md`.

## Known limitations

- **Non-numeric claims are not checked by code.** Grounding catches unsupported times, prices, phone numbers and booking claims, but not, for example, a wrong "this dish is vegan". Diet tags in the facts fixed every such case in the tests, but that is measured, not guaranteed.
- **Related weak spots:**
  - A claim inside a hedged sentence ("we'd have a table if you came at 9") is not caught.
  - Grounding checks that a price exists in the cited facts, not which dish it belongs to.
- **"next Friday"** is read as the coming Friday rather than asked about. The date is always shown back before booking.
- **Recommendations take two model calls**, so they are slower than other replies.
- **Menu data limits.**
  - The seed labels the Chocolate Chilli Mousse both vegetarian and containing egg; it appears for "vegetarian" with "Contains egg" on its card.
  - Allergen labels cover only dairy, nuts and egg, so every answer involving an allergy carries a "tell your server" note.
- **Speed.** Warm replies take about 2–4 s on an M4 Pro, but were slower than 4 s when the machine was heavily loaded. The first reply after the model loads can take 8–14 s; the server warms the model when it starts and every 15 minutes, so this happens only if Ollama was restarted (the chat then says it's still working).
- **Out of scope:**
  - guests can't change or cancel a booking themselves: the chat gives the branch phone, and staff cancel in admin;
  - no payments, SMS or email, guest accounts, waitlists or table joining;
  - English only.
- **Not production-hardened.** It runs as a single local process (in-memory rate limits) with no staff password, and binds to 127.0.0.1.
- **Evaluation caveat.** The evaluation is a finite set of conversations: evidence, not proof.
