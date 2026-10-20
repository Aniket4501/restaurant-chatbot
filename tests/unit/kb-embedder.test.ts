import { describe, expect, it } from "vitest";
import { decodeF32, encodeF32, EmbedError, fakeEmbedder, hashVector, ollamaEmbedder, queryText, readFixture, textKey } from "@/lib/kb/embedder";

const BASE = "http://127.0.0.1:11434";
const MODEL = "qwen3-embedding:0.6b";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const norm = (v: Float32Array) => Math.hypot(...v);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    expect(e).toBeInstanceOf(EmbedError);
    return (e as EmbedError).code;
  }
}

describe("ollamaEmbedder (stubbed fetch)", () => {
  it("posts the D-05 body and returns unit vectors in input order", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const e = ollamaEmbedder({
      baseUrl: BASE,
      model: MODEL,
      fetch: async (url, init) => {
        sent = { url: String(url), body: JSON.parse(String(init?.body)) };
        return json(200, { embeddings: [[3, 4], [0, 2]] });
      },
    });
    const [a, b] = await e.embed(["x", "y"]);
    expect(sent).toEqual({ url: `${BASE}/api/embed`, body: { model: MODEL, input: ["x", "y"], keep_alive: "30m", truncate: false } });
    expect([...a].map((x) => +x.toFixed(6))).toEqual([0.6, 0.8]);
    expect([...b]).toEqual([0, 1]);
    expect(await e.embed([])).toEqual([]);
  });

  it("maps connection refused, 404, 5xx, 400, timeouts and malformed bodies to error codes", async () => {
    const withFetch = (f: typeof fetch) => ollamaEmbedder({ baseUrl: BASE, model: MODEL, fetch: f });
    const refused = withFetch(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(await code(refused.embed(["x"]))).toBe("EMBED_UNAVAILABLE");
    expect(await code(refused.digest())).toBe("EMBED_UNAVAILABLE");
    expect(await code(withFetch(async () => json(404, { error: "model not found" })).embed(["x"]))).toBe("EMBED_NOT_PULLED");
    expect(await code(withFetch(async () => json(500, { error: "boom" })).embed(["x"]))).toBe("EMBED_UNAVAILABLE");
    expect(await code(withFetch(async () => json(400, { error: "bad" })).embed(["x"]))).toBe("EMBED_INVALID_OUTPUT");
    expect(await code(withFetch(async () => new Response("not json", { status: 200 })).embed(["x"]))).toBe("EMBED_INVALID_OUTPUT");
    expect(await code(withFetch(async () => json(200, { embeddings: [[1, 0]] })).embed(["x", "y"]))).toBe("EMBED_INVALID_OUTPUT");
    expect(await code(withFetch(async () => json(200, { embeddings: [[1, 0], [1]] })).embed(["x", "y"]))).toBe("EMBED_INVALID_OUTPUT");
    expect(await code(withFetch(async () => json(200, { embeddings: [[0, 0]] })).embed(["x"]))).toBe("EMBED_INVALID_OUTPUT");
    expect(await code(withFetch(async () => json(200, { embeddings: [[1, "a"]] })).embed(["x"]))).toBe("EMBED_INVALID_OUTPUT");
    const hang = withFetch(
      (_u, init) =>
        new Promise((_r, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    expect(await code(hang.embed(["x"], { signal: AbortSignal.timeout(20) }))).toBe("EMBED_TIMEOUT");
  });

  it("reads the digest from /api/tags and reports a missing model as not pulled", async () => {
    const e = ollamaEmbedder({ baseUrl: BASE, model: MODEL, fetch: async () => json(200, { models: [{ name: "qwen3.5:9b", digest: "d63f" }, { name: MODEL, model: MODEL, digest: "ac6d" }] }) });
    expect(await e.digest()).toBe("ac6d");
    const missing = ollamaEmbedder({ baseUrl: BASE, model: MODEL, fetch: async () => json(200, { models: [{ name: "qwen3.5:9b", digest: "d63f" }] }) });
    expect(await code(missing.digest())).toBe("EMBED_NOT_PULLED");
  });
});

describe("fakeEmbedder (D-12)", () => {
  const fixture = readFixture();

  it("replays the recorded qwen3-embedding vectors for known text", async () => {
    expect(fixture.model).toBe(MODEL);
    expect(fixture.dim).toBe(1024);
    const [key, rec] = Object.entries(fixture.vectors).find(([, v]) => v.kind === "query")!;
    expect(textKey(rec.text)).toBe(key);
    const e = fakeEmbedder(fixture);
    const [v] = await e.embed([rec.text]);
    expect(encodeF32(v)).toBe(rec.f32);
    expect(norm(v)).toBeCloseTo(1, 5);
    expect(e.misses).toEqual([]);
    expect(await e.digest()).toBe(`fake:${fixture.digest}`);
  });

  it("gives unseen text a deterministic unit hash vector and records the miss", async () => {
    const e = fakeEmbedder(fixture);
    const [a] = await e.embed([queryText("something nobody asked")]);
    const [b] = await e.embed([queryText("something nobody asked")]);
    expect(a).toEqual(b);
    expect(a.length).toBe(1024);
    expect(norm(a)).toBeCloseTo(1, 5);
    expect(hashVector("x", 8)).not.toEqual(hashVector("y", 8));
    expect(e.misses.length).toBe(2);
  });

  it("honours the #fake:embed_down and #fake:embed_timeout directives", async () => {
    const e = fakeEmbedder(fixture);
    expect(await code(e.embed([queryText("menu #fake:embed_down")]))).toBe("EMBED_UNAVAILABLE");
    expect(await code(e.embed([queryText("menu #fake:embed_timeout")]))).toBe("EMBED_TIMEOUT");
  });

  it("round-trips float32 vectors through base64, including from unaligned buffers", () => {
    const v = new Float32Array([0.1, -0.2, 0.3]);
    expect(decodeF32(encodeF32(v))).toEqual(v);
    const padded = Buffer.concat([Buffer.from([0]), Buffer.from(v.buffer)]).subarray(1);
    expect(decodeF32(padded.toString("base64"))).toEqual(v);
  });
});
