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
cp .env.example .env.local     # set ADMIN_PASSWORD (12+ characters) and ADMIN_SESSION_SECRET (openssl rand -hex 32)
npm run setup                  # migrate and seed data/app.db, index the menu and FAQ facts, check the model
npm run model:warm             # optional: loads the model so the first reply is quick
npm run dev                    # http://127.0.0.1:3000 for guests, http://127.0.0.1:3000/admin for staff
```

The app listens on 127.0.0.1 only. Staff pages stay disabled until both admin values are set in `.env.local`. To start from fresh demo data, run `npm run db:reset && npm run kb:index`. This rebuilds `data/app.db`, deleting any bookings made so far, and re-indexes the facts; without `kb:index`, retrieval falls back to keyword search.

## What you can do

**Guests** (`/`):
- Ask a question, for example "Do you have parking at Hauz Khas?" or "How much is the butter chicken?". Unknown or unrelated questions get a short fallback with the branch phone number.
- Tap **Book a table**, then choose a branch, date, party size and one of the open times. Enter your name and mobile number, then tap Confirm.
- You can also type a request, for example "table for 2 tomorrow at 8pm at Golf Course Road".

The booking reference appears only after the booking has been saved. Full times, invalid party sizes (online booking is for 1 to 8 guests), past dates and dates more than 30 days ahead are explained, with alternatives where there are any.

**Staff** (`/admin`): sign in with `ADMIN_PASSWORD`, pick a date (it opens on today) and optionally a branch. You see the day's booking and guest counts and a table of each booking's time, guest, party size, branch and status. Cancelling a booking frees its table straight away.

## How it works

```
guest message ──► mask phone and email ──► retrieve facts (SQLite FTS5 + embeddings)
              ──► one model call returning JSON: intent, booking fields, FAQ answer with cited fact IDs
              ──► code checks everything ──► reply

booking fields ──► validate ──► availability engine ──► open times ──► confirm card ──► POST /api/reservations
```

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

**Chat model: `qwen3.5:9b` on Ollama.**
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
npm run verify:release   # also checks the model and runs the live evals 3 times
```

## Known limitations

- **Non-numeric claims are not checked by code.** Grounding catches unsupported times, prices, phone numbers and booking claims, but not, for example, a wrong "this dish is vegan". Diet tags in the facts fixed every such case in the tests, but that is measured, not guaranteed.
- **Related weak spots:**
  - A claim inside a hedged sentence ("we'd have a table if you came at 9") is not caught.
  - Grounding checks that a price exists in the cited facts, not which dish it belongs to.
- **"next Friday"** is read as the coming Friday rather than asked about. The date is always shown back before booking.
- **Speed.** Warm replies take about 2–4 s on an M4 Pro, but were slower than 4 s when the machine was heavily loaded. The first reply after the model loads can take 8–14 s; `npm run model:warm` avoids that.
- **Out of scope:**
  - guests can't change or cancel a booking themselves: the chat gives the branch phone, and staff cancel in admin;
  - no payments, SMS or email, guest accounts, waitlists or table joining;
  - English only.
- **Not production-hardened.** It runs as a single local process (in-memory rate limits) with one shared staff password, and binds to 127.0.0.1.
- **Evaluation caveat.** The evaluation is a finite set of conversations: evidence, not proof.
