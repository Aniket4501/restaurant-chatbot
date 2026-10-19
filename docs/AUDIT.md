# Phase 0 audit (2026-10-19)

## What exists

Greenfield. The folder was empty on 16 Oct. Everything present was created on 19 Oct during setup and Phase 0: `docs/MASTER_PROMPT.md` (exact Markdown export of the "Master prompt" tab, doc rev 4, 63,594 bytes, 879 lines), `.gitignore` (7.2 list plus `.DS_Store`), `CLAUDE.md` (10.4), `.claude/agents/independent-reviewer.md` (10.5), `docs/AUDIT.md`, `docs/DECISIONS.md`, `docs/STATUS.md`. No `package.json`, README, code, or dependencies, so there was no baseline lint/test/build to run (step 4).

## Environment

| Item | Value | Status |
| --- | --- | --- |
| Machine | Apple M4 Pro, 24 GB unified memory, macOS 26.5.1 | OK. The overview tab assumed 16 GB; the master prompt does not |
| Disk free | 173 GiB | OK (need ≥ 15 GB) |
| Node / npm | v25.8.0 / 11.11.0 | Meets ≥ 22. See risk R2 |
| Xcode CLT | `/Library/Developer/CommandLineTools` | Present (native-build fallback) |
| git | 2.50.1; branch `build/reservation-bot`, no commits | Blocked: no `user.name`/`user.email` |
| Ollama | 0.40.5, `127.0.0.1:11434` answering | OK |
| Models | `qwen3.5:4b` (7f3251fa6878, 4.0 GB). `qwen3.5:9b` not pulled; no pull in progress (server log: last `/api/pull` 18 Oct) | 9b needed for Phase 2 probe |
| Claude Code | 2.1.303; `ANTHROPIC_API_KEY` unset | User to confirm `/status` shows subscription login |

## Missing prerequisites

1. `.claude/settings.json` with the 7.4 deny rules and compaction hook. The user must add it; Claude must not edit permission settings (H12).
2. Git identity for commits.
3. `/status` confirmation of the subscription login.
4. Permission mode: the plan expects Manual for Phases 0–3. This session was in auto mode during setup \[Unverified now\].

## Risks

- **R1 Memory.** The GPU can likely use ~75% of RAM, so ~18 GB \[Unverified, third-party source\]. `qwen3.5:9b` (6.6–7.6 GB) should fit with the browser and dev server open \[Inferred\]. That is still under 24 GiB of VRAM, so Ollama's 4k default context applies and `num_ctx` must always be sent \[Inferred from 5.8\].
- **R2 Node 25.** It is an odd-numbered, non-LTS line \[Verified: version\]. Its support status should be checked in Phase 2 \[Unverified\]. better-sqlite3 13.0.3 ships `prebuilds/darwin-arm64.node` and builds on `node-addon-api` \[Verified: `npm pack --dry-run`, `npm view`\], so no native compile is expected on Node 25 \[Inferred\]. Option for G1: install Node 24 LTS.
- **R3 Network.** Wi-Fi IPv6 is broken: `curl -6` to the Ollama registry times out and `curl -4` works \[Verified 18 Oct\]. `ollama pull` fails until IPv6 is turned off for the download. Any new pull needs the user's approval for that workaround.
- **R4 Process.** `git init` was run on 19 Oct during setup (overview tab, step 4) without the ask that 7.2 requires. No commits were made, so nothing needs undoing.
- **R5 Sequencing.** The user wants model-independent work to proceed during the 9b download. The plan blocks all application code until G2, and G2 requires measured model numbers. Proposed change: D-01.

## Do not touch

`docs/MASTER_PROMPT.md` (the user edits it), `.claude/settings.json` (the user's), `~/.ollama` models, system network settings (approval needed each time), and `data/app.db` from tests once it exists.
