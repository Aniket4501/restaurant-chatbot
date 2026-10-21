import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiDeps } from "@/lib/api/deps";
import { loadConfig } from "@/lib/config";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { createLimiter } from "@/lib/http/ratelimit";
import { fakeEmbedder, type Embedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { indexKb } from "@/lib/kb/index";
import { createRefresher } from "@/lib/kb/refresh";
import type { FakeScript } from "@/lib/llm/fake";
import { testChatDeps } from "../../helpers/chat-deps";
import { tempDb } from "./db";

// Staff workspace tests (D-25): a temp database seeded from evals/fixtures/base.json and fully indexed with the fake
// embedder, the real handlers, a fixed clock, and the scripted model. Never data/app.db.

export const SEED = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../evals/fixtures/base.json"), "utf8")));
export const E2E_SCRIPT = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../e2e/fake-script.json"), "utf8")) as FakeScript;

/**
 * `hold`: the refresher's embedder waits until `release()` (only for the refresher; chat turns use the plain fake), so a
 * test can look at the state between a save and its background embedding without racing it.
 */
export async function seeded(label: string, now: number, o: { embedder?: Embedder | null; script?: FakeScript; hold?: boolean } = {}) {
  const t = tempDb(label);
  applySeed(t.db, SEED, { now });
  await indexKb(t.db, renderKbFacts(loadFactSource(t.db)), fakeEmbedder(), now);
  let clock = now;
  const embedder = o.embedder === undefined ? fakeEmbedder() : o.embedder;
  const chat = testChatDeps({ script: o.script ?? E2E_SCRIPT, embedder });
  const deps: ApiDeps = {
    db: () => t.db,
    now: () => clock,
    config: () => loadConfig({ DATABASE_PATH: path.join(os.tmpdir(), "x.db") }),
    fetch,
    limits: { createsPerPhone: createLimiter({ limit: 100, windowMs: 60_000 }), createsGlobal: createLimiter({ limit: 100, windowMs: 60_000 }) },
    chat,
  };
  let release: () => void = () => {};
  let gate = Promise.resolve();
  if (o.hold) gate = new Promise<void>((r) => (release = r));
  const inner = chat.embedder();
  const held: Embedder | null = inner && { provider: inner.provider, model: inner.model, digest: async (x) => (await gate, inner.digest(x)), embed: (i, x) => inner.embed(i, x) };
  deps.kb = { refresher: createRefresher({ db: deps.db, embedder: () => held, now: deps.now }) };
  return { t, deps, setNow: (n: number) => (clock = n), release: () => release() };
}

/** Call a handler like the route does; JSON bodies get the app's content type. */
export async function call<P extends Record<string, string>>(
  h: (req: Request, ctx?: { params: Promise<P> }) => Promise<Response>,
  method: string,
  url: string,
  body?: unknown,
  params?: P,
): Promise<{ status: number; json: Awaited<ReturnType<Response["json"]>> }> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await h(new Request(`http://127.0.0.1:3100${url}`, init), { params: Promise.resolve((params ?? {}) as P) });
  return { status: res.status, json: await res.json() };
}

/** A multipart upload body like the browser sends. */
export function upload(name: string, content: string | Uint8Array, fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("file", new File([Uint8Array.from(typeof content === "string" ? new TextEncoder().encode(content) : content)], name));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
