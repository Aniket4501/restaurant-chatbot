import { getConfig, LIMITS, type AppConfig } from "@/lib/config";
import { createModelGate, turnLimiter, type ModelGate, type TurnLimiter } from "@/lib/chat/ratelimit";
import { getDb, type DB } from "@/lib/db/client";
import { createLimiter, type Limiter } from "@/lib/http/ratelimit";
import { embedderFor, type Embedder } from "@/lib/kb/embedder";
import { createRefresher, type Refresher } from "@/lib/kb/refresh";
import type { ModelClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/llm/provider";
import { loadedChecker } from "@/lib/llm/warmth";
import { getNow } from "@/lib/time/now";

/**
 * What the API handlers need, injected so tests run the real handlers against temp databases and a fixed clock
 * (D-12). Route files bind the handlers to `defaultDeps()`.
 */
export type ApiDeps = {
  db: () => DB;
  now: () => number;
  config: () => AppConfig;
  fetch: typeof fetch;
  limits: { createsPerPhone: Limiter; createsGlobal: Limiter };
  /** Chat turn dependencies (D-12): the configured model and embedder, turn limits and the model-call gate (D-14). */
  chat: { model: () => ModelClient; embedder: () => Embedder | null; limiter: TurnLimiter; gate: ModelGate; modelLoaded?: () => Promise<boolean | null> };
  /** D-25: the knowledge index refresher (embeds after staff edits). Optional: `refresherOf` makes one from `db`/`chat`. */
  kb?: { refresher: Refresher };
};

const refreshers = new WeakMap<ApiDeps, Refresher>();
/** The deps' index refresher, or one made (once per deps object) from its database and embedder. */
export function refresherOf(deps: ApiDeps): Refresher {
  if (deps.kb) return deps.kb.refresher;
  let r = refreshers.get(deps);
  if (!r) refreshers.set(deps, (r = createRefresher({ db: deps.db, embedder: deps.chat.embedder, now: deps.now })));
  return r;
}

function lazy<T>(make: () => T): () => T {
  let v: { value: T } | null = null;
  return () => (v ??= { value: make() }).value;
}

// Kept on globalThis: the route bundles and the instrumentation bundle (lib/llm/warmer.ts) each get their own copy of
// this module, and they must share one model gate and one set of limits (D-23 review; like lib/evals/jobs.ts).
const g = globalThis as typeof globalThis & { __rcApiDeps?: ApiDeps };
export function defaultDeps(): ApiDeps {
  if (!g.__rcApiDeps) {
    const testCreates = () => getConfig().test?.createsPerMin;
    g.__rcApiDeps = {
      db: getDb,
      now: () => getNow(),
      config: getConfig,
      fetch: (...a) => fetch(...a),
      limits: {
        createsPerPhone: createLimiter({ limit: testCreates() ?? LIMITS.createsPerMinPerPhone, windowMs: 60_000 }),
        createsGlobal: createLimiter({ limit: (testCreates() ?? 0) * 6 || LIMITS.createsPerMinGlobal, windowMs: 60_000 }),
      },
      chat: {
        model: lazy(() => modelFor(getConfig())),
        embedder: lazy(() => embedderFor(getConfig())),
        limiter: turnLimiter(
          createLimiter({ limit: getConfig().test?.turnsPerMin ?? LIMITS.turnsPerMin, windowMs: 60_000 }),
          createLimiter({ limit: getConfig().test?.turnsPerMin ?? LIMITS.turnsPerMin, windowMs: 60_000 }),
        ),
        gate: createModelGate({ concurrency: 1, maxQueue: 4 }),
        modelLoaded: getConfig().llmProvider === "ollama" ? loadedChecker(getConfig().ollamaBaseUrl, getConfig().chatModel) : undefined,
      },
    };
  }
  return g.__rcApiDeps;
}

/** Lazily bind a handler factory to the default deps on first request (never at import: `next build` imports routes). */
export function bind<A extends unknown[]>(make: (deps: ApiDeps) => (...a: A) => Promise<Response>): (...a: A) => Promise<Response> {
  let h: ((...a: A) => Promise<Response>) | null = null;
  return (...a: A) => {
    h ??= make(defaultDeps());
    return h(...a);
  };
}
