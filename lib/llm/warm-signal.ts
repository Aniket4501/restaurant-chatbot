// D-25: staff edits to the restaurant, branches, hours or special dates change the chatbot's system prompt, so the
// model's cached prompt prefix no longer matches and the next guest turn would pay for a full prefill. The warmer
// (lib/llm/warmer.ts, instrumentation bundle) registers a handler here and the admin API calls requestWarm() after such
// edits; the handler debounces and runs one warm-up round through the guest model gate. Kept on globalThis because the
// route and instrumentation bundles each get their own copy of this module. No handler (tests, fake model): a no-op.

type G = typeof globalThis & { __rcWarmNow?: () => void };

export function onWarmRequest(fn: () => void): void {
  (globalThis as G).__rcWarmNow = fn;
}

export function requestWarm(): void {
  (globalThis as G).__rcWarmNow?.();
}
