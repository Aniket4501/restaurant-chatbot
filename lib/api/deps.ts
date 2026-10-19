import { getConfig, LIMITS, type AppConfig } from "@/lib/config";
import { getDb, type DB } from "@/lib/db/client";
import { createLimiter, type Limiter } from "@/lib/http/ratelimit";
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
};

let shared: ApiDeps | null = null;
export function defaultDeps(): ApiDeps {
  if (!shared) {
    const testCreates = () => getConfig().test?.createsPerMin;
    shared = {
      db: getDb,
      now: () => getNow(),
      config: getConfig,
      fetch: (...a) => fetch(...a),
      limits: {
        createsPerPhone: createLimiter({ limit: testCreates() ?? LIMITS.createsPerMinPerPhone, windowMs: 60_000 }),
        createsGlobal: createLimiter({ limit: (testCreates() ?? 0) * 6 || LIMITS.createsPerMinGlobal, windowMs: 60_000 }),
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
