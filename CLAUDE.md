# Restaurant reservation chatbot
Every session: read docs/STATUS.md, then docs/MASTER_PROMPT.md section 3 (hard rules) and your phase in section 8.
Update docs/STATUS.md after every task. Stop at gates until the user replies "APPROVE Gn".

## Commands
npm run dev | verify | verify:release | test:unit | test:integration | test:e2e | eval:scripted | eval | model:check | db:reset

## Never
- Use or request a Claude/Anthropic API key; add any hosted-model provider (Ollama and fake only)
- Push, deploy, add remotes, install, or delete without explicit approval
- Claim a pass you didn't run; weaken or skip tests; lower thresholds
- Let the UI confirm a booking without a saved row (201/200)
- Commit .env* (except .env.example), data/*.db*, or guest data; log guest text
- Hide a failure, fabricate a result, or retry an uncertain operation without inspecting state first
- Touch data/app.db from tests
- Start a phase past a pending gate

## Conventions
- All booking time math in the branch time zone; pass `now` in, never read the clock inside logic
- Booking writes: synchronous better-sqlite3 IMMEDIATE transaction; map errors by code/message
- When compacting, keep: current task, files changed, last test results, open questions
