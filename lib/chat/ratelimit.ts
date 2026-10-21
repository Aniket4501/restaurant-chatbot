import type { Limiter } from "@/lib/http/ratelimit";

// Chat abuse limits (§5.7 step 1, D-12, D-14). The route supplies them; the eval runner passes the no-op versions.
// - Turns: 20 per minute per session and per socket address. Next.js route handlers expose no socket address, and
//   X-Forwarded-For is never trusted, so on this 127.0.0.1-only server the address bucket is one global key
//   (documented in D-14).
// - Model calls: at most one at a time (one Ollama runner slot, D-05), with a small queue; beyond it, 429.

export type TurnLimiter = { allow(sessionId: string, now: number): { ok: true } | { ok: false; retryAfterMs: number }; reset?(): void };

export function turnLimiter(perSession: Limiter, perAddress: Limiter, addressKey = "local"): TurnLimiter {
  return {
    allow(sessionId, now) {
      const s = perSession.hit(`session:${sessionId}`, now);
      if (!s.ok) return s;
      return perAddress.hit(`addr:${addressKey}`, now);
    },
    reset() {
      perSession.reset();
      perAddress.reset();
    },
  };
}

export const noTurnLimit: TurnLimiter = { allow: () => ({ ok: true }) };

export class GateFullError extends Error {
  constructor(message = "too many model calls waiting") {
    super(message);
    this.name = "GateFullError";
  }
}

export type ModelGate = { run<T>(fn: () => Promise<T>): Promise<T>; readonly active: number; readonly waiting: number };

/**
 * Run at most `concurrency` calls at once; up to `maxQueue` more wait in order; any beyond that are refused. A call that
 * has waited `maxWaitMs` leaves the queue with GateFullError, so a guest is told the assistant is busy instead of waiting
 * behind a slow warm-up or a stuck model call for minutes (failure-mode audit FM-015).
 */
export function createModelGate(opts: { concurrency?: number; maxQueue?: number; maxWaitMs?: number } = {}): ModelGate {
  const concurrency = opts.concurrency ?? 1;
  const maxQueue = opts.maxQueue ?? 4;
  const maxWaitMs = opts.maxWaitMs;
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  };
  return {
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    async run(fn) {
      if (active >= concurrency) {
        if (queue.length >= maxQueue) throw new GateFullError();
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const go = () => {
            if (timer) clearTimeout(timer);
            resolve();
          };
          if (maxWaitMs !== undefined)
            timer = setTimeout(() => {
              const i = queue.indexOf(go);
              if (i < 0) return;
              queue.splice(i, 1);
              reject(new GateFullError("waited too long for the model"));
            }, maxWaitMs);
          queue.push(go);
        });
      } else active++;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export const openGate: ModelGate = { run: (fn) => fn(), active: 0, waiting: 0 };
