import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MODEL, type AppConfig } from "@/lib/config";

// The embedder boundary (D-02, D-12). Exactly two implementations: Ollama (`/api/embed`, local only) and a fake
// that replays vectors recorded from the real model, so hybrid retrieval is reproducible offline. No hosted SDK.

export type EmbedErrorCode = "EMBED_UNAVAILABLE" | "EMBED_NOT_PULLED" | "EMBED_TIMEOUT" | "EMBED_INVALID_OUTPUT";

/** Every embedder failure is one of these; retrieval maps all of them to lexical mode (never a crash). */
export class EmbedError extends Error {
  constructor(
    readonly code: EmbedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

export type EmbedOptions = { signal?: AbortSignal };

export interface Embedder {
  readonly provider: "ollama" | "fake";
  readonly model: string;
  /** The model digest vectors are keyed by (Ollama `/api/tags`), so a re-pulled model never reuses stale vectors. */
  digest(opts?: EmbedOptions): Promise<string>;
  /** One unit-length vector per input, in input order. Rejects with EmbedError. */
  embed(inputs: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
}

/** Task instruction for queries (qwen3-embedding: queries carry an instruction, documents are embedded raw). */
export const EMBED_INSTRUCT = "Given a restaurant guest's message, retrieve the menu items and restaurant policies that answer it";
export const docText = (factText: string) => factText.normalize("NFKC");
export const queryText = (query: string) => `Instruct: ${EMBED_INSTRUCT}\nQuery:${query.normalize("NFKC")}`;
export const textKey = (input: string) => createHash("sha256").update(input).digest("hex");

function unit(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  const norm = Math.sqrt(n);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function isAbort(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Ollama `/api/embed` with D-05 settings (keep_alive, truncate:false). Errors map by HTTP status, not message text. */
export function ollamaEmbedder(opts: { baseUrl: string; model: string; fetch?: typeof fetch }): Embedder {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const call = async (pathname: string, init: RequestInit, signal?: AbortSignal): Promise<Response> => {
    try {
      return await doFetch(`${opts.baseUrl}${pathname}`, { ...init, signal });
    } catch (e) {
      if (isAbort(e)) throw new EmbedError("EMBED_TIMEOUT", "the embedding model did not answer in time");
      throw new EmbedError("EMBED_UNAVAILABLE", "cannot reach Ollama. Is `ollama serve` running?");
    }
  };
  const readJson = async (res: Response): Promise<unknown> => {
    try {
      return await res.json();
    } catch (e) {
      if (isAbort(e)) throw new EmbedError("EMBED_TIMEOUT", "the embedding model did not answer in time");
      throw new EmbedError("EMBED_INVALID_OUTPUT", "Ollama returned a body that is not JSON");
    }
  };
  return {
    provider: "ollama",
    model: opts.model,
    async digest(o = {}) {
      const res = await call("/api/tags", { method: "GET" }, o.signal);
      if (!res.ok) throw new EmbedError("EMBED_UNAVAILABLE", `Ollama /api/tags returned HTTP ${res.status}`);
      const tags = (await readJson(res)) as { models?: { name?: string; model?: string; digest?: string }[] };
      const found = tags.models?.find((m) => m.name === opts.model || m.model === opts.model);
      if (!found?.digest) throw new EmbedError("EMBED_NOT_PULLED", `the embedding model is not pulled. Run \`ollama pull ${opts.model}\``);
      return found.digest;
    },
    async embed(inputs, o = {}) {
      if (inputs.length === 0) return [];
      const res = await call(
        "/api/embed",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: opts.model, input: inputs, keep_alive: MODEL.keepAlive, truncate: false }) },
        o.signal,
      );
      if (res.status === 404) throw new EmbedError("EMBED_NOT_PULLED", `the embedding model is not pulled. Run \`ollama pull ${opts.model}\``);
      if (!res.ok) throw new EmbedError(res.status >= 500 ? "EMBED_UNAVAILABLE" : "EMBED_INVALID_OUTPUT", `Ollama /api/embed returned HTTP ${res.status}`);
      const body = (await readJson(res)) as { embeddings?: unknown };
      const vs = body.embeddings;
      if (!Array.isArray(vs) || vs.length !== inputs.length) throw new EmbedError("EMBED_INVALID_OUTPUT", "Ollama returned the wrong number of embeddings");
      const dim = Array.isArray(vs[0]) ? vs[0].length : 0;
      return vs.map((v) => {
        if (!Array.isArray(v) || v.length !== dim || dim === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x)) || v.every((x) => x === 0))
          throw new EmbedError("EMBED_INVALID_OUTPUT", "Ollama returned a malformed embedding");
        return unit(v as number[]);
      });
    },
  };
}

// ---------- fake (D-12) ----------

export type EmbeddingFixture = {
  version: 1;
  model: string;
  digest: string;
  dim: number;
  instruct: string;
  /** sha256(input) → the recorded input and its float32 little-endian vector, base64. */
  vectors: Record<string, { kind: "doc" | "query"; text: string; f32: string }>;
};

export const FIXTURE_PATH = path.join(process.cwd(), "evals", "fixtures", "embeddings.json");

export function readFixture(file = FIXTURE_PATH): EmbeddingFixture {
  return JSON.parse(fs.readFileSync(file, "utf8")) as EmbeddingFixture;
}

export function encodeF32(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

export function decodeF32(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  return new Float32Array(new Uint8Array(bytes).buffer); // copy: Buffer offsets need not be 4-byte aligned
}

/** A deterministic unit vector for text the fixture has never seen (stable across runs and machines). */
export function hashVector(input: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  let block = Buffer.alloc(0);
  for (let i = 0, ctr = 0; i < dim; i++) {
    if ((i * 4) % 32 === 0) block = createHash("sha256").update(`${ctr++}:${input}`).digest();
    v[i] = block.readInt32LE((i * 4) % 32) / 2 ** 31;
  }
  return unit(v);
}

/**
 * Replays recorded vectors; unseen text gets `hashVector`. Directives in an input (D-12): `#fake:embed_down`
 * → EMBED_UNAVAILABLE, `#fake:embed_timeout` → EMBED_TIMEOUT (immediately, so tests stay fast).
 */
export function fakeEmbedder(fixture: EmbeddingFixture = readFixture()): Embedder & { misses: string[] } {
  const known = new Map(Object.entries(fixture.vectors).map(([k, v]) => [k, decodeF32(v.f32)]));
  const misses: string[] = [];
  return {
    provider: "fake",
    model: fixture.model,
    misses,
    async digest() {
      return `fake:${fixture.digest}`;
    },
    async embed(inputs) {
      for (const s of inputs) {
        if (s.includes("#fake:embed_down")) throw new EmbedError("EMBED_UNAVAILABLE", "fake embedder: down (#fake:embed_down)");
        if (s.includes("#fake:embed_timeout")) throw new EmbedError("EMBED_TIMEOUT", "fake embedder: timeout (#fake:embed_timeout)");
      }
      return inputs.map((s) => {
        const v = known.get(textKey(s));
        if (v) return v;
        misses.push(s);
        return hashVector(s, fixture.dim);
      });
    },
  };
}

/** The configured embedder: the fake in test mode (D-12) or when EMBED_PROVIDER=fake, else local Ollama. */
export function embedderFor(config: AppConfig, fetchImpl?: typeof fetch): Embedder {
  return config.embedProvider === "fake" ? fakeEmbedder() : ollamaEmbedder({ baseUrl: config.ollamaBaseUrl, model: config.embedModel, fetch: fetchImpl });
}
