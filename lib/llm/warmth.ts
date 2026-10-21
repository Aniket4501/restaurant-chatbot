import { MODEL } from "@/lib/config";

// D-23. A turn's model calls normally get MODEL.chatTimeoutMs. When Ollama reports the chat model unloaded (idle past
// keep-alive, or Ollama restarted), loading it takes longer than that, so the turn's calls get the cold timeout:
// the guest waits longer once instead of getting a "couldn't work that out" reply.
export function modelTimeout(loaded: boolean | null, override?: number): number {
  return override ?? (loaded === false ? MODEL.coldTimeoutMs : MODEL.chatTimeoutMs);
}

/** Whether Ollama has the model loaded (`/api/ps`); null when it can't tell (then the usual timeout applies). */
export function loadedChecker(baseUrl: string, model: string, doFetch: typeof fetch = fetch): () => Promise<boolean | null> {
  const norm = (n: string | undefined) => (n ? (n.includes(":") ? n : `${n}:latest`).toLowerCase() : "");
  return async () => {
    try {
      const r = await doFetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(500) });
      if (!r.ok) return null;
      const models = ((await r.json()) as { models?: { name?: string; model?: string }[] }).models ?? [];
      return models.some((m) => norm(m.name) === norm(model) || norm(m.model) === norm(model));
    } catch {
      return null;
    }
  };
}
