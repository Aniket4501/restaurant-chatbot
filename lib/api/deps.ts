import { getConfig, LIMITS, type AppConfig } from "@/lib/config";
import { createModelGate, turnLimiter, type ModelGate, type TurnLimiter } from "@/lib/chat/ratelimit";
import { getDb, type DB } from "@/lib/db/client";
import { createLimiter, type Limiter } from "@/lib/http/ratelimit";
import { embedderFor, type Embedder } from "@/lib/kb/embedder";
import type { ModelClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/llm/provider";
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
  /** Where admin secrets are read from (D-16); process.env in production. */
  adminEnv: () => Record<string, string | undefined>;
  limits: { createsPerPhone: Limiter; createsGlobal: Limiter; adminLogin: Limiter };
  /** Chat turn dependencies (D-12): the configured model and embedder, turn limits and the model-call gate (D-14). */
  chat: { model: () => ModelClient; embedder: () => Embedder | null; limiter: TurnLimiter; gate: ModelGate };
};

function lazy<T>(make: () => T): () => T {
  let v: { value: T } | null = null;
  return () => (v ??= { value: make() }).value;
}

let shared: ApiDeps | null = null;
export function defaultDeps(): ApiDeps {
  if (!shared) {
    const testCreates = () => getConfig().test?.createsPerMin;
    shared = {
      db: getDb,
      now: () => getNow(),
      config: getConfig,
      fetch: (...a) => fetch(...a),
      adminEnv: () => process.env,
      limits: {
        adminLogin: createLimiter({ limit: getConfig().test?.adminLoginPerMin ?? LIMITS.adminLoginPerMin, windowMs: 60_000 }),
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
      },
    };
  }
  return shared;
}

/** Lazily bind a handler factory to the default deps on first request (never at import: `next build` imports routes). */
export function bind<A extends unknown[]>(make: (deps: ApiDeps) => (...a: A) => Promise<Response>): (...a: A) => Promise<Response> {
  let h: ((...a: A) => Promise<Response>) | null = null;
  return (...a: A) => {
    h ??= make(defaultDeps());
    return h(...a);
  };
}
