import fs from "node:fs";
import { getConfig } from "@/lib/config";
import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { docText, encodeF32, EMBED_INSTRUCT, FIXTURE_PATH, ollamaEmbedder, queryText, textKey, type EmbeddingFixture } from "@/lib/kb/embedder";
import { indexedText, loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { retrievalQuery } from "@/lib/kb/retrieve";

// npx tsx scripts/kb-embed-fixture.ts   Records real vectors for the fake embedder (D-12) from the local Ollama
// embedding model: every retrievable fact of evals/fixtures/base.json, the labelled retrieval queries (probe R01–R30,
// retrieval-aggregates A01–A10), and the
// probe and eval-case guest messages. Existing vectors are kept when the model digest is unchanged, so adding
// cases never changes recorded ones. Talks only to OLLAMA_BASE_URL (loopback, enforced by lib/config).
const config = getConfig();
const embedder = ollamaEmbedder({ baseUrl: config.ollamaBaseUrl, model: config.embedModel });
const wait = () => ({ signal: AbortSignal.timeout(120_000) });

const base = JSON.parse(fs.readFileSync("evals/fixtures/base.json", "utf8"));
const probe = JSON.parse(fs.readFileSync("evals/fixtures/probe-messages.json", "utf8"));
const db = openDb(":memory:");
migrate(db, Date.parse(probe.now));
applySeed(db, parseSeed(base), { now: Date.parse(probe.now) });
const docs = renderKbFacts(loadFactSource(db)).map((f) => docText(indexedText(f)));
db.close();

type Msg = { guest: string; history?: { role: string; content: string }[] };
const aggregates = JSON.parse(fs.readFileSync("evals/fixtures/retrieval-aggregates.json", "utf8"));
const queries = new Set<string>([...probe.retrieval, ...aggregates.queries].map((r: { query: string }) => r.query));
for (const m of [...probe.chat, ...probe.heldout, ...probe.edge] as Msg[]) {
  const prev = (m.history ?? []).filter((h) => h.role === "user" || h.role === "guest").at(-1)?.content ?? null;
  queries.add(retrievalQuery(m.guest, prev));
}
if (fs.existsSync("evals/cases"))
  for (const f of fs.readdirSync("evals/cases").filter((n) => n.endsWith(".jsonl")))
    for (const line of fs.readFileSync(`evals/cases/${f}`, "utf8").split("\n").filter(Boolean)) {
      const c = JSON.parse(line) as { turns?: { guest?: string }[] };
      let prev: string | null = null;
      for (const t of c.turns ?? [])
        if (typeof t.guest === "string") {
          queries.add(retrievalQuery(t.guest, prev));
          prev = t.guest;
        }
    }

const digest = await embedder.digest(wait());
const old: EmbeddingFixture | null = fs.existsSync(FIXTURE_PATH) ? JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) : null;
const vectors: EmbeddingFixture["vectors"] = old && old.digest === digest && old.instruct === EMBED_INSTRUCT ? { ...old.vectors } : {};
const before = Object.keys(vectors).length;

const newDocs = docs.filter((d) => !vectors[textKey(d)]);
for (let i = 0; i < newDocs.length; i += 16) {
  const batch = newDocs.slice(i, i + 16);
  (await embedder.embed(batch, wait())).forEach((v, j) => (vectors[textKey(batch[j])] = { kind: "doc", text: batch[j], f32: encodeF32(v) }));
}
for (const q of queries) {
  const input = queryText(q);
  if (vectors[textKey(input)]) continue;
  const [v] = await embedder.embed([input], wait()); // one per call, as at runtime
  vectors[textKey(input)] = { kind: "query", text: input, f32: encodeF32(v) };
}

// Keep only vectors for current inputs, so edited fact text leaves no dead entries behind.
const wanted = new Set([...docs.map(textKey), ...[...queries].map((q) => textKey(queryText(q)))]);
const dim = Buffer.from(Object.values(vectors)[0].f32, "base64").byteLength / 4;
const sorted = Object.fromEntries(Object.entries(vectors).filter(([k]) => wanted.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
const out: EmbeddingFixture = { version: 1, model: config.embedModel, digest, dim, instruct: EMBED_INSTRUCT, vectors: sorted };
fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(out, null, 1)}\n`);
console.log(`embeddings.json: ${Object.keys(sorted).length} vectors (${Object.keys(vectors).length - before} new, ${Object.keys(vectors).length - Object.keys(sorted).length} pruned; ${docs.length} facts, ${queries.size} queries), ${config.embedModel} ${digest.slice(0, 12)}, dim ${dim}`);
