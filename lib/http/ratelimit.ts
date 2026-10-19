// Fixed-window rate limiter with bounded memory (D-14, D-15). Time comes from the caller (injected clock), so
// tests and evals control it. Keys are dropped oldest-first beyond `maxKeys`.
export type Limiter = { hit(key: string, now: number): { ok: true } | { ok: false; retryAfterMs: number }; reset(): void };

export function createLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }): Limiter {
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, { start: number; count: number }>();
  return {
    hit(key, now) {
      let b = buckets.get(key);
      if (!b || now - b.start >= opts.windowMs) {
        b = { start: now, count: 0 };
        buckets.delete(key);
        buckets.set(key, b);
        if (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value as string);
      }
      if (b.count >= opts.limit) return { ok: false, retryAfterMs: b.start + opts.windowMs - now };
      b.count++;
      return { ok: true };
    },
    reset() {
      buckets.clear();
    },
  };
}

/** A limiter that never refuses (the eval runner's; D-12). */
export const noLimit: Limiter = { hit: () => ({ ok: true }), reset: () => {} };
