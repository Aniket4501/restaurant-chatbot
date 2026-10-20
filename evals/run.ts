import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ApiDeps } from "@/lib/api/deps";
import { reservationsHandler } from "@/lib/api/reservations";
import { createReservation } from "@/lib/booking/create";
import { noTurnLimit, openGate } from "@/lib/chat/ratelimit";
import { submitOutcome, type SubmitBranch } from "@/lib/chat/submit";
import { branchInfo } from "@/lib/chat/templates";
import { runTurn, systemInputFor } from "@/lib/chat/turn";
import { emptyDraft, type Action, type Block, type ChatMessage, type Draft, type TraceEntry } from "@/lib/chat/types";
import { loadConfig, MODEL } from "@/lib/config";
import { openDb, type DB } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { createLimiter } from "@/lib/http/ratelimit";
import { phonesIn, pricesIn, timesIn } from "@/lib/kb/canonical";
import { EmbedError, embedderFor, fakeEmbedder, type Embedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts, renderStaticFacts } from "@/lib/kb/facts";
import { indexKb } from "@/lib/kb/index";
import type { ModelClient } from "@/lib/llm/client";
import { sequenceModel, type FakeReply } from "@/lib/llm/fake";
import { buildSystemPrompt, PROMPT_VERSION } from "@/lib/llm/prompt";
import { plantSnapshot } from "@/lib/llm/ollama";
import { TURN_JSON_SCHEMA } from "@/lib/llm/schema";
import { maskText } from "@/lib/llm/redact";
import { modelFor, OLLAMA_CHAT_READY } from "@/lib/llm/provider";
import { toInstant } from "@/lib/time/tz";
import { CATEGORIES, loadCases, type EvalCase, type Expectation } from "@/evals/case";
import { checkCase, offeredStarts, snapshotRows, type CaseRecord, type TurnRecord, type Violation } from "@/evals/invariants";

// Eval runner (MASTER_PROMPT §6, D-12): `npm run eval:scripted` (D1, fake model) and `npm run eval` (D2, Ollama).
// Every case runs on a fresh temp database loaded from evals/fixtures/base.json, with the case's `now`. Chat turns go
// through runTurn; {submit} turns call the reservation route's handler as the ConfirmCard would, using the same
// submitOutcome mapping as the UI. Exits non-zero if any case fails or any invariant is violated (INV-08).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZONE = "Asia/Kolkata";

export type CaseResult = {
  id: string;
  category: string;
  severity: string;
  run: number;
  passed: boolean;
  failures: string[];
  violations: Violation[];
  modelCalls: number;
  turns: {
    kind: string;
    /** Masked guest text, the action, or "submit" (the transcript, §6.7). */
    input: string;
    reply: string;
    blocks: string[];
    cited: string[];
    outcome: string | null;
    intent: string | null;
    retrievalMode: string | null;
    latencyMs: number | null;
    modelMs: number | null;
    promptTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    firstTryValid: boolean | null;
  }[];
};

const SCRIPT_TOKENS: Record<string, FakeReply> = { "<<INVALID_JSON>>": "#fake:invalid", "<<TIMEOUT>>": "#fake:timeout", "<<DOWN>>": "#fake:down" };

function failingEmbedder(kind: "down" | "timeout"): Embedder {
  const base = fakeEmbedder();
  const err = () => new EmbedError(kind === "down" ? "EMBED_UNAVAILABLE" : "EMBED_TIMEOUT", `eval: embedder ${kind}`);
  return { ...base, digest: base.digest, embed: async () => Promise.reject(err()) };
}

/** A unique valid Indian mobile for synthetic guests (setup bookings and other-guest turns). */
const syntheticPhone = (i: number) => `+9190000${String(10000 + i).slice(-5)}`;

function deepMatch(actual: unknown, want: unknown): boolean {
  if (want === null || typeof want !== "object") return actual === want;
  if (Array.isArray(want)) return Array.isArray(actual) && want.length === actual.length && want.every((w, i) => deepMatch(actual[i], w));
  return !!actual && typeof actual === "object" && Object.entries(want).every(([k, w]) => deepMatch((actual as Record<string, unknown>)[k], w));
}

type TurnView = TurnRecord & { intent: string | null; draft: Draft; retrievalMode: string | null; submit: { status: number; code: string | null; ref: string | null } | null; modelCalls: number };

function checkExpect(e: Expectation | undefined, t: TurnView, ctx: { createdRefs: () => string[]; refOfTurn: (i: number) => string | null }): string[] {
  if (!e) return [];
  const f: string[] = [];
  const text = t.shown?.text ?? "";
  const blocks = t.shown?.blocks ?? [];
  const slots = blocks.find((b) => b.type === "slots") as Extract<Block, { type: "slots" }> | undefined;
  const fail = (s: string) => f.push(`turn ${t.index + 1}: ${s}`);
  if (e.intent !== undefined && t.intent !== e.intent) fail(`intent ${t.intent} ≠ ${e.intent}`);
  if (e.outcome !== undefined && t.outcome !== e.outcome) fail(`outcome ${t.outcome} ≠ ${e.outcome}`);
  if (e.actions) {
    let i = 0;
    for (const want of e.actions) {
      while (i < t.trace.length && !(t.trace[i].action === want.name && (!want.args || deepMatch((t.trace[i] as { args?: unknown }).args, want.args)))) i++;
      if (i >= t.trace.length) fail(`missing action ${want.name}${want.args ? ` ${JSON.stringify(want.args)}` : ""} (trace: ${t.trace.map((x) => x.action).join(", ")})`);
      else i++;
    }
  }
  for (const n of e.noActions ?? []) if (t.trace.some((x) => x.action === n)) fail(`unexpected action ${n}`);
  if (e.draft && !deepMatch(t.draft, e.draft)) fail(`draft ${JSON.stringify(t.draft)} does not match ${JSON.stringify(e.draft)}`);
  for (const b of e.blocks ?? []) if (!blocks.some((x) => x.type === b)) fail(`no ${b} block (got ${blocks.map((x) => x.type).join(", ") || "none"})`);
  if (e.fieldRequest && !blocks.some((x) => x.type === "field_request" && x.field === e.fieldRequest)) fail(`no field_request for ${e.fieldRequest}`);
  const offered = slots?.groups.flatMap((g) => g.slots.map((s) => s.time)) ?? [];
  for (const time of e.slotsInclude ?? []) if (!offered.includes(time)) fail(`slot ${time} not offered (${offered.join(" ")})`);
  for (const time of e.slotsExclude ?? []) if (offered.includes(time)) fail(`slot ${time} offered`);
  if (e.alternativesMin !== undefined && (slots?.alternatives.length ?? 0) < e.alternativesMin) fail(`alternatives ${slots?.alternatives.length ?? 0} < ${e.alternativesMin}`);
  for (const id of e.mustCite ?? []) if (!t.citedFactIds.includes(id)) fail(`did not cite ${id} (cited ${t.citedFactIds.join(", ") || "none"})`);
  for (const v of e.mustIncludeValues ?? []) {
    const ok = /^\d{2}:\d{2}$/.test(v) ? timesIn(text).has(Number(v.slice(0, 2)) * 60 + Number(v.slice(3))) : v.startsWith("₹") ? pricesIn(text).has(Number(v.slice(1))) : v.startsWith("+") ? phonesIn(text).has(v) : text.includes(v);
    if (!ok) fail(`reply lacks ${v}`);
  }
  if (e.mustAbstain !== undefined && (t.outcome === "faq_fallback") !== e.mustAbstain) fail(e.mustAbstain ? `did not abstain (outcome ${t.outcome})` : "abstained");
  if (e.reservationsCreated !== undefined && ctx.createdRefs().length !== e.reservationsCreated) fail(`reservations created ${ctx.createdRefs().length} ≠ ${e.reservationsCreated}`);
  for (const re of e.replyMustMatch ?? []) if (!new RegExp(re, "i").test(text)) fail(`reply does not match /${re}/: "${text.slice(0, 100)}"`);
  for (const re of e.replyMustNotMatch ?? []) if (new RegExp(re, "i").test(text)) fail(`reply matches /${re}/`);
  if (e.retrievalMode !== undefined && t.retrievalMode !== e.retrievalMode) fail(`retrieval ${t.retrievalMode} ≠ ${e.retrievalMode}`);
  if (e.modelCalls !== undefined && t.modelCalls !== e.modelCalls) fail(`model calls ${t.modelCalls} ≠ ${e.modelCalls}`);
  if (e.submitStatus !== undefined && t.submit?.status !== e.submitStatus) fail(`submit status ${t.submit?.status} ≠ ${e.submitStatus}`);
  if (e.submitCode !== undefined && (t.submit?.code ?? null) !== e.submitCode) fail(`submit code ${t.submit?.code} ≠ ${e.submitCode}`);
  if (e.sameRefAsTurn !== undefined && (!t.submit?.ref || t.submit.ref !== ctx.refOfTurn(e.sameRefAsTurn - 1))) fail(`ref ${t.submit?.ref} ≠ turn ${e.sameRefAsTurn}'s ${ctx.refOfTurn(e.sameRefAsTurn - 1)}`);
  return f;
}

/** One block as a transcript line: its type plus what the guest saw (times, the card, the ref, the notice). */
function blockLine(b: Block): string {
  switch (b.type) {
    case "slots":
      return `slots ${b.heading}: ${b.groups.flatMap((g) => g.slots.map((x) => x.time)).join(" ")}${b.alternatives.length ? ` | other: ${b.alternatives.map((a) => a.label).join(", ")}` : ""}`;
    case "confirm":
      return `confirm ${b.branch} ${b.date} ${b.time} x${b.partySize}`;
    case "confirmation":
      return `confirmation ${b.ref}`;
    case "notice":
      return `notice: ${b.text}`;
    case "info":
      return `info ${b.factIds.join(", ")}`;
    case "field_request":
      return `ask ${b.field}: ${b.chips.map((c) => c.label).join(" / ")}`;
    case "quick_replies":
      return `chips: ${b.chips.map((c) => c.label).join(" / ")}`;
  }
}

/**
 * A seeded, retrieval-indexed fixture database to copy for each case, so the live embedder indexes the 86 facts once
 * per run instead of once per case. Returns its path; the caller removes the directory.
 */
export async function prepareTemplate(embedder: Embedder | null, now: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-eval-template-"));
  const file = path.join(dir, "template.db");
  const db = openDb(file);
  migrate(db, now);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now });
  if (embedder) await indexKb(db, renderKbFacts(loadFactSource(db)), embedder, now, { signal: AbortSignal.timeout(300_000) });
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return file;
}

export async function runCase(c: EvalCase, opts: { mode: "scripted" | "live"; run?: number; model?: ModelClient; embedder?: Embedder | null; template?: string } = { mode: "scripted" }): Promise<CaseResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-eval-"));
  const file = path.join(dir, "app.db");
  const failures: string[] = [];
  const logs: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  let db: DB | null = null;
  const result: CaseResult = { id: c.id, category: c.category, severity: c.severity, run: opts.run ?? 1, passed: false, failures, violations: [], modelCalls: 0, turns: [] };
  try {
    console.log = console.warn = console.error = console.info = capture;
    const now = Date.parse(c.now);
    const baseEmbedder = opts.mode === "live" ? (opts.embedder ?? null) : fakeEmbedder();
    if (opts.template) {
      fs.copyFileSync(opts.template, file);
      db = openDb(file);
    } else {
      db = openDb(file);
      migrate(db, now);
      applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now });
      if (baseEmbedder) await indexKb(db, renderKbFacts(loadFactSource(db)), baseEmbedder, now, { signal: AbortSignal.timeout(300_000) });
    }
    const embedder = c.embedder ? failingEmbedder(c.embedder) : baseEmbedder;

    // Setup.
    const setupRefs = new Set<string>();
    let synth = 0;
    const bookAs = (branch: string, start: string, party: number, phone?: string, name = "Setup Guest") => {
      const [date, time] = start.split("T");
      return createReservation(db!, { branch, startsAt: toInstant(date, time, ZONE), partySize: party, name, phone: phone ?? syntheticPhone(synth++) }, randomUUID(), now);
    };
    let faultAvailability = false;
    let faultCreateLock = false;
    for (const op of c.setup ?? []) {
      if (op.op === "fault") {
        if (op.target === "availability") faultAvailability = true;
        else faultCreateLock = true;
        continue;
      }
      if (op.op === "book") {
        const r = bookAs(op.branch, op.start, op.party, op.phone, op.name);
        if (!("reservation" in r)) throw new Error(`setup book failed: ${r.code}`);
        setupRefs.add(r.reservation.ref);
      } else {
        for (let i = 0; i < 20; i++) {
          const r = bookAs(op.branch, op.start, op.party);
          if (!("reservation" in r)) break;
          setupRefs.add(r.reservation.ref);
        }
      }
    }

    const scripted = opts.mode === "scripted" ? sequenceModel((c.modelScript ?? []).map((r) => (typeof r === "string" && SCRIPT_TOKENS[r]) || r) as FakeReply[]) : null;
    const model = scripted ?? opts.model!;
    const branches = db.prepare("SELECT slug, name, address, phone, timezone FROM branches WHERE is_active = 1 ORDER BY id").all() as { slug: string; name: string; address: string; phone: string; timezone: string }[];
    const submitBranches: SubmitBranch[] = branches.map(branchInfo).map((b) => ({ slug: b.slug, name: b.name, short: b.short, phoneLabel: b.phoneLabel }));
    const apiDeps = (handle: DB): ApiDeps => ({
      db: () => handle,
      now: () => now,
      config: () => loadConfig({ DATABASE_PATH: file }),
      fetch: (...a) => fetch(...a),
      adminEnv: () => ({}),
      limits: { createsPerPhone: createLimiter({ limit: 1000, windowMs: 60_000 }), createsGlobal: createLimiter({ limit: 1000, windowMs: 60_000 }), adminLogin: createLimiter({ limit: 5, windowMs: 60_000 }) },
      chat: { model: () => model, embedder: () => embedder, limiter: noTurnLimit, gate: openGate },
    });

    // Client state, as the browser keeps it.
    let draft: Draft = emptyDraft();
    let context: { lastCitedIds: string[] } = { lastCitedIds: [] };
    let history: ChatMessage[] = [];
    let lastConfirm: Extract<Block, { type: "confirm" }> | null = null;
    let lastSubmit: { key: string; body: Record<string, unknown>; card: Extract<Block, { type: "confirm" }> } | null = null;
    const records: TurnView[] = [];
    const bookTurnRefs = new Set<string>();
    const guestTexts: string[] = [];
    const submittedNames: string[] = [];
    const submittedPii: string[] = [];
    const createdRefs = () => snapshotRows(db!).map((r) => r.ref).filter((r) => !setupRefs.has(r) && !bookTurnRefs.has(r));

    const doSubmit = async (key: string, body: Record<string, unknown>, card: Extract<Block, { type: "confirm" }>, lock: boolean) => {
      let handle = db!;
      let locker: DB | null = null;
      if (lock) {
        locker = openDb(file);
        locker.prepare("BEGIN IMMEDIATE").run();
        handle = openDb(file, { timeoutMs: 50 });
      }
      try {
        const res = await reservationsHandler(apiDeps(handle))(new Request("http://127.0.0.1/api/reservations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) }));
        const json = await res.json();
        return { status: res.status, json, outcome: submitOutcome({ status: res.status, body: json }, { branch: submitBranches.find((b) => b.slug === card.branch)!, branches: submitBranches, date: card.date, partySize: card.partySize }) };
      } finally {
        if (locker) {
          locker.prepare("ROLLBACK").run();
          locker.close();
          handle.close();
        }
      }
    };

    for (const [index, turn] of c.turns.entries()) {
      const rowsBefore = snapshotRows(db);
      const prompts: string[] = [];
      let shown: TurnRecord["shown"] = null;
      let outcome: string | null = null;
      let intent: string | null = null;
      let citedFactIds: string[] = [];
      let trace: TraceEntry[] = [];
      let retrievalMode: string | null = null;
      let submit: TurnView["submit"] = null;
      const kind = (Object.keys(turn).find((k) => k !== "expect") ?? "guest") as TurnRecord["kind"];
      const facts = (() => {
        const src = loadFactSource(db!);
        return new Map([...renderStaticFacts(src, now), ...renderKbFacts(src)].map((f) => [f.id, f.text]));
      })();
      const chat = async (input: { messages: ChatMessage[]; action?: Action }) => {
        const r = await runTurn(
          { now, sessionId: "00000000-0000-4000-8000-000000000000", messages: input.messages, draft, action: input.action, context },
          { db: db!, model, embedder, limiter: noTurnLimit, gate: openGate, onPrompt: (p) => prompts.push(`${p.system}\n${p.user}`), loadBundle: faultAvailability ? () => { throw new Error("eval fault: availability read failed"); } : undefined },
        );
        shown = r.reply;
        outcome = r.meta.outcome;
        intent = r.intent;
        citedFactIds = r.meta.citedFactIds;
        trace = r.trace;
        retrievalMode = r.meta.retrievalMode;
        draft = r.draft;
        context = r.context;
        const confirm = r.reply.blocks.find((b) => b.type === "confirm") as Extract<Block, { type: "confirm" }> | undefined;
        if (confirm) lastConfirm = confirm;
        else if (!r.draft.selected) lastConfirm = null;
        const last = input.messages.at(-1);
        result.turns.push({
          kind,
          input: input.action ? JSON.stringify(input.action) : maskText(last?.content ?? ""),
          reply: r.reply.text,
          blocks: r.reply.blocks.map(blockLine),
          cited: r.meta.citedFactIds,
          outcome,
          intent,
          retrievalMode,
          latencyMs: r.meta.latencyMs,
          modelMs: r.meta.modelMs,
          promptTokens: r.meta.promptTokens,
          cachedTokens: r.meta.cachedTokens,
          outputTokens: r.meta.outputTokens,
          firstTryValid: r.trace.some((x) => x.action === "model_call") ? (r.trace.find((x) => x.action === "model_call") as { result: string }).result === "ok" : null,
        });
        return r;
      };

      if ("guest" in turn) {
        guestTexts.push(turn.guest);
        history = [...history, { role: "guest" as const, content: turn.guest }].slice(-8);
        const r = await chat({ messages: history });
        history = [...history, { role: "assistant" as const, content: r.reply.text.slice(0, 600) }].slice(-7);
      } else if ("action" in turn) {
        const a = turn.action;
        const action: Action = "start" in a ? { type: "select_slot", branch: a.branch, startsAt: toInstant(a.start.slice(0, 10), a.start.slice(11), ZONE) } : a;
        await chat({ messages: [], action });
      } else if ("submit" in turn) {
        if (!lastConfirm) throw new Error(`turn ${index + 1}: {submit} without a confirm card`);
        const card: Extract<Block, { type: "confirm" }> = lastConfirm;
        submittedNames.push(turn.submit.name);
        submittedPii.push(turn.submit.phone, turn.submit.phone.replace(/\D/g, ""), ...(turn.submit.email ? [turn.submit.email] : []));
        const body = { branch: card.branch, startsAt: card.startsAtMs, partySize: card.partySize, name: turn.submit.name, phone: turn.submit.phone, email: turn.submit.email ?? null, note: turn.submit.note ?? null };
        // The client reuses a key only to retry an identical body (§5.9).
        const prev: { key: string; body: Record<string, unknown> } | null = lastSubmit;
        const key: string = prev && JSON.stringify(prev.body) === JSON.stringify(body) ? prev.key : randomUUID();
        const lock = faultCreateLock && !records.some((x) => x.kind === "submit");
        const r = await doSubmit(key, body, card, lock);
        const ref = (r.json as { reservation?: { ref: string } }).reservation?.ref ?? null;
        submit = { status: r.status, code: (r.json as { error?: { code?: string } }).error?.code ?? null, ref };
        trace = [{ action: "create_reservation", result: submit }];
        shown = { text: r.outcome.text, blocks: r.outcome.blocks };
        outcome = "submit";
        lastSubmit = { key, body, card }; // remembered so a lost response or reload can replay it
        result.turns.push({ kind, input: `submit (HTTP ${r.status})`, reply: r.outcome.text, blocks: r.outcome.blocks.map(blockLine), cited: [], outcome: "submit", intent: null, retrievalMode: null, latencyMs: null, modelMs: null, promptTokens: null, cachedTokens: null, outputTokens: null, firstTryValid: null });
        if (r.outcome.clearDraft) {
          draft = emptyDraft();
          lastConfirm = null;
        }
        history = [...history, { role: "assistant" as const, content: r.outcome.text }].slice(-7);
      } else if ("simulate" in turn) {
        // A lost response or a reload with a pending submit: the client replays the same key and body (D-14).
        if (lastSubmit) {
          const r = await doSubmit(lastSubmit.key, lastSubmit.body, lastSubmit.card, false);
          const ref = (r.json as { reservation?: { ref: string } }).reservation?.ref ?? null;
          submit = { status: r.status, code: (r.json as { error?: { code?: string } }).error?.code ?? null, ref };
          trace = [{ action: "create_reservation", result: submit }];
          shown = { text: r.outcome.text, blocks: r.outcome.blocks };
          outcome = "submit";
          if (r.outcome.clearDraft) {
            draft = emptyDraft();
            lastConfirm = null;
          }
        }
      } else if ("book" in turn) {
        const r = bookAs(turn.book.branch, turn.book.start, turn.book.party, turn.book.phone ?? syntheticPhone(500 + index), "Other Guest");
        if (!("reservation" in r)) throw new Error(`turn ${index + 1}: {book} failed: ${r.code}`);
        bookTurnRefs.add(r.reservation.ref);
      }

      const rec: TurnView = {
        index,
        kind,
        now,
        shown,
        outcome,
        citedFactIds,
        factText: facts,
        trace,
        rowsBefore,
        rowsAfter: snapshotRows(db),
        offered: shown ? offeredStarts(db, (shown as { blocks: Block[] }).blocks, now) : [],
        prompts,
        intent,
        draft,
        retrievalMode,
        submit,
        modelCalls: trace.filter((x) => x.action === "model_call").length,
      };
      records.push(rec);
      result.modelCalls += rec.modelCalls;
      failures.push(...checkExpect(turn.expect, rec, { createdRefs, refOfTurn: (i) => records[i]?.submit?.ref ?? null }));
    }

    const last = records.at(-1)!;
    failures.push(...checkExpect(c.expect, last, { createdRefs, refOfTurn: (i) => records[i]?.submit?.ref ?? null }).map((s) => s.replace(/^turn \d+:/, "case:")));
    for (const fb of c.forbidden ?? []) {
      if (fb === "reservation_created" && createdRefs().length) failures.push(`forbidden: reservation_created (${createdRefs().length})`);
    }
    if (scripted && scripted.remaining() > 0) failures.push(`modelScript has ${scripted.remaining()} unused replies`);

    const rec: CaseRecord = {
      turns: records,
      setupRefs: new Set([...setupRefs, ...bookTurnRefs]),
      guestTexts: guestTexts.filter((g) => g.trim().length >= 8),
      submittedNames,
      submittedPii,
      chatTurns: db.prepare("SELECT * FROM chat_turns").all() as Record<string, unknown>[],
      logs,
    };
    result.violations = checkCase(db, rec);
  } catch (e) {
    failures.push(`error: ${(e as Error).message}`);
  } finally {
    Object.assign(console, saved);
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  result.passed = failures.length === 0 && result.violations.length === 0;
  return result;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function sh(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const mode = arg("mode");
  if (mode !== "scripted" && mode !== "live") {
    console.error("usage: tsx evals/run.ts --mode scripted|live [--case ID,ID] [--category slug] [--runs N] [--cases DIR] [--out FILE]");
    return 2;
  }
  const casesDir = path.resolve(arg("cases") ?? path.join(ROOT, "evals/cases"));
  const category = arg("category");
  if (category && !(CATEGORIES as readonly string[]).includes(category)) {
    console.error(`unknown category ${category}`);
    return 2;
  }
  if (mode === "live" && !OLLAMA_CHAT_READY) {
    console.error("eval --mode live needs the Ollama chat client (T-18). Nothing was run.");
    return 2;
  }
  const only = arg("case")?.split(",");
  const runs = Number(arg("runs") ?? "1");
  let cases: EvalCase[];
  try {
    cases = loadCases(casesDir);
  } catch (e) {
    console.error(`eval: ${(e as Error).message}`);
    return 2;
  }
  cases = cases.filter((c) => c.mode === mode && (!category || c.category === category) && (!only || only.includes(c.id)));
  if (!cases.length) {
    console.error(`eval: no ${mode} cases selected`);
    return 2;
  }
  let model: ModelClient | undefined;
  let embedder: Embedder | null = null;
  if (mode === "live") {
    const config = loadConfig({ ...process.env, LLM_PROVIDER: "ollama", EMBED_PROVIDER: "ollama", E2E_TEST_MODE: undefined });
    model = modelFor(config);
    embedder = embedderFor(config);
  }
  const results: CaseResult[] = [];
  const started = new Date();
  const partial = mode === "live" ? path.join(ROOT, "evals/results", `${started.toISOString().replace(/[:.]/g, "-")}_${mode}.partial.jsonl`) : null;
  const template = await prepareTemplate(mode === "live" ? embedder : fakeEmbedder(), Date.parse(cases[0].now));
  let warmup: unknown = null;
  if (mode === "live") {
    // Warm the prefix for the cases' own date, so the first measured turn isn't a cold prefill (§6.5 reports cold
    // load separately). All live cases share one `now`; another date would pay one cold prefill.
    const cfg = loadConfig({ ...process.env, LLM_PROVIDER: "ollama", EMBED_PROVIDER: "ollama", E2E_TEST_MODE: undefined });
    const tdb = openDb(template);
    const system = buildSystemPrompt(systemInputFor(tdb, Date.parse(cases[0].now)));
    tdb.close();
    warmup = await plantSnapshot({ baseUrl: cfg.ollamaBaseUrl, model: cfg.chatModel, system, format: TURN_JSON_SCHEMA, timeoutMs: MODEL.warmTimeoutMs });
    console.log(`warm-up (not scored): ${JSON.stringify(warmup)}`);
  }
  for (let run = 1; run <= runs; run++)
    for (const c of cases) {
      const r = await runCase(c, { mode, run, model, embedder, template });
      results.push(r);
      if (partial) fs.appendFileSync(partial, `${JSON.stringify(r)}\n`);
      const why = [...r.failures, ...r.violations.map((v) => `${v.inv}${v.turn !== null ? ` turn ${v.turn + 1}` : ""}: ${v.detail}`)];
      console.log(`${r.passed ? "PASS" : "FAIL"} ${c.id} ${c.category}${runs > 1 ? ` run ${run}` : ""}${why.length ? `\n     ${why.join("\n     ")}` : ""}`);
    }
  fs.rmSync(path.dirname(template), { recursive: true, force: true });
  const passed = results.filter((r) => r.passed).length;
  const violations = results.reduce((n, r) => n + r.violations.length, 0);
  const datasetHash = createHash("sha256")
    .update(fs.readdirSync(casesDir).filter((n) => n.endsWith(".jsonl")).sort().map((n) => fs.readFileSync(path.join(casesDir, n), "utf8")).join("\n"))
    .digest("hex")
    .slice(0, 16);
  const meta = {
    kind: `eval-${mode}`,
    startedAt: started.toISOString(),
    gitSha: sh("git", ["rev-parse", "--short", "HEAD"]),
    promptVersion: PROMPT_VERSION,
    dataset: { dir: path.relative(ROOT, casesDir), hash: datasetHash, cases: cases.length },
    node: process.version,
    chip: os.cpus()[0]?.model ?? null,
    ramBytes: os.totalmem(),
    numCtx: MODEL.numCtx,
    temperature: MODEL.temperature,
    seed: MODEL.seed,
    runs,
    model: model?.model ?? "fake-sequence",
    warmup,
    loadAverage: os.loadavg(),
  };
  const label = arg("label") ? `_${arg("label")!.replace(/[^a-z0-9-]+/gi, "-")}` : "";
  const out = path.resolve(arg("out") ?? (mode === "live" ? path.join(ROOT, "evals/results", `${started.toISOString().replace(/[:.]/g, "-")}_${(model?.model ?? "model").replace(/[^a-z0-9.]+/gi, "-")}${label}.json`) : path.join(ROOT, "test-results/evals/scripted-latest.json")));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ meta, summary: { cases: results.length, passed, failed: results.length - passed, invariantViolations: violations }, results }, null, 1)}\n`);
  console.log(`eval:${mode} ${passed}/${results.length} passed, ${violations} invariant violations → ${path.relative(ROOT, out)}`);
  return passed === results.length && violations === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
