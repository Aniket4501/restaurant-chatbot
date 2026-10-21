import { afterEach, describe, expect, it } from "vitest";
import { documentFileHandler, documentHandlers, documentReingestHandler, knowledgeHandlers, previewHandler, refreshHandler } from "@/lib/api/admin-workspace";
import { runTurn } from "@/lib/chat/turn";
import { noTurnLimit } from "@/lib/chat/ratelimit";
import { EmbedError, fakeEmbedder, type Embedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { embeddingCoverage, lexicalCurrent } from "@/lib/kb/index";
import { retrieveFacts } from "@/lib/kb/retrieve";
import { fakeModel, nullBooking } from "@/lib/llm/fake";
import { call, seeded, upload } from "./helpers/admin";

// D-25 knowledge base: documents are ingested (extract → normalise → chunk → keyword index) in the request and embedded
// in the background; every status is read back from the stored rows; edits and deletions leave no stale passages.
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
let s: Awaited<ReturnType<typeof seeded>>;
afterEach(() => s?.t.cleanup());

const db = () => s.t.db;
const facts = () => renderKbFacts(loadFactSource(db()));
const docFacts = () => facts().filter((f) => f.kind === "doc");
const settle = async () => {
  s.release();
  await s.deps.kb!.refresher.idle();
};
const kb = () => knowledgeHandlers(s.deps);
const doc = () => documentHandlers(s.deps);
const overview = async () => (await call(kb().GET, "GET", "/api/admin/knowledge")).json;
const detail = async (id: number) => (await call(doc().GET, "GET", `/api/admin/knowledge/${id}`, undefined, { id: String(id) })).json;
const preview = async (query: string) => (await call(previewHandler(s.deps), "POST", "/api/admin/knowledge/preview", { query })).json;

const POLICY = `# Corkage and outside drinks

Guests may bring their own wine to Golf Course Road. Corkage is ₹1,000 per bottle, and we serve it in our glassware.

## Spirits

Outside spirits are not allowed at either branch.`;

const article = (over: Record<string, unknown> = {}) => call(kb().POST, "POST", "/api/admin/knowledge", { title: "Corkage policy", docType: "payment", branch: null, text: POLICY, ...over });

describe("knowledge documents (D-25)", () => {
  it("shows the built-in sources with real index counts and no documents on a fresh database", async () => {
    s = await seeded("kb", NOW);
    const o = await overview();
    expect(o.documents).toEqual([]);
    expect(o.builtIn.map((b: { key: string; facts: number; keyword: number; vectors: number }) => [b.key, b.facts, b.keyword, b.vectors])).toEqual([
      ["menu", 61, 61, 61],
      ["faq", 25, 25, 25],
      ["prompt", expect.any(Number), 0, null],
    ]);
    expect(o.index).toMatchObject({ facts: 86, keyword: 86, vectors: 86, mode: "hybrid", reason: null, refreshPending: false });
  });

  it("an article becomes passages the chatbot retrieves; it is keyword-searchable at once and searchable by meaning after the refresh", async () => {
    s = await seeded("kb", NOW, { hold: true });
    const r = await article();
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(r.json.warnings).toEqual([]);
    expect(docFacts().map((f) => [f.id, f.text])).toEqual([
      ["doc:corkage-policy:1", "Corkage policy (Corkage and outside drinks): Guests may bring their own wine to Golf Course Road. Corkage is ₹1,000 per bottle, and we serve it in our glassware."],
      ["doc:corkage-policy:2", "Corkage policy (Spirits): Outside spirits are not allowed at either branch."],
    ]);
    expect(lexicalCurrent(db(), facts())).toBe(true);
    let d = await detail(r.json.id);
    expect(d.document.state).toBe("keyword_only");
    expect(d.document.stages.map((x: { key: string; status: string }) => `${x.key}:${x.status}`)).toEqual(["extract:done", "normalize:done", "chunk:done", "keyword:done", "embed:pending"]);
    expect(d.jobs[0]).toMatchObject({ kind: "ingest", status: "succeeded", summary: "2 passages" });
    const before = await preview("can I bring my own wine? corkage");
    expect(before.mode).toBe("lexical");
    expect(before.hits[0]).toMatchObject({ factId: "doc:corkage-policy:1", kind: "doc", source: "Corkage policy, passage 1", href: `/admin/knowledge/${r.json.id}` });
    await settle();
    d = await detail(r.json.id);
    expect(d.document.state).toBe("searchable");
    expect(d.passages.map((p: { keyword: boolean; vector: boolean }) => [p.keyword, p.vector])).toEqual([[true, true], [true, true]]);
    expect((await preview("corkage fee for wine")).mode).toBe("hybrid");
    expect((await overview()).counts).toMatchObject({ documents: 1, searchable: 1, passages: 2 });
  });

  it("the chatbot can cite a passage and its answer passes the grounding check", async () => {
    s = await seeded("kb", NOW);
    await article();
    await settle();
    const answer = "Yes, at Golf Course Road: corkage is ₹1,000 per bottle.";
    const model = fakeModel({ script: { "Can I bring my own wine?": { intent: "faq", booking: nullBooking(), prefs: null, answer, citedFactIds: ["doc:corkage-policy:1"], answerable: true } } });
    const r = await runTurn({ now: NOW, sessionId: "00000000-0000-4000-8000-000000000003", messages: [{ role: "guest", content: "Can I bring my own wine?" }], draft: null }, { db: db(), model, embedder: fakeEmbedder(), limiter: noTurnLimit });
    expect(r.trace[0]).toMatchObject({ action: "retrieve", ids: expect.arrayContaining(["doc:corkage-policy:1"]) });
    expect(r.meta.outcome).toBe("faq_answer");
    expect(r.reply.text).toBe(answer);
    expect(r.meta.citedFactIds).toEqual(["doc:corkage-policy:1"]);
    // A passage that wasn't retrieved for this question (the spirits one) can't be cited: like any fact not sent.
    const unsent = fakeModel({ script: { "Can I bring my own wine?": { intent: "faq", booking: nullBooking(), prefs: null, answer: "Outside spirits are not allowed.", citedFactIds: ["doc:corkage-policy:2"], answerable: true } } });
    const u = await runTurn({ now: NOW, sessionId: "00000000-0000-4000-8000-000000000005", messages: [{ role: "guest", content: "Can I bring my own wine?" }], draft: null }, { db: db(), model: unsent, embedder: fakeEmbedder(), limiter: noTurnLimit });
    expect(u.trace.find((x) => x.action === "fallback_unknown")).toMatchObject({ reason: "not_sent" });
    // A price the passage doesn't state is refused like any other ungrounded number.
    const wrong = fakeModel({ script: { "Can I bring my own wine?": { intent: "faq", booking: nullBooking(), prefs: null, answer: "Corkage is ₹800 per bottle.", citedFactIds: ["doc:corkage-policy:1"], answerable: true } } });
    const w = await runTurn({ now: NOW, sessionId: "00000000-0000-4000-8000-000000000004", messages: [{ role: "guest", content: "Can I bring my own wine?" }], draft: null }, { db: db(), model: wrong, embedder: fakeEmbedder(), limiter: noTurnLimit });
    expect(w.meta.outcome).toBe("faq_fallback");
  });

  it("uploads Markdown and plain text; refuses other types; stores an unreadable file as failed with the reason", async () => {
    s = await seeded("kb", NOW);
    const md = await call(kb().POST, "POST", "/api/admin/knowledge", upload("dress-code.md", "# Dress code\n\nSmart casual. **No beachwear** in the evening.", { docType: "other", branch: "" }));
    expect(md.status).toBe(201);
    expect(md.json.ok).toBe(true);
    expect(docFacts().map((f) => f.text)).toEqual(["dress code (Dress code): Smart casual. No beachwear in the evening."]);
    const pdf = await call(kb().POST, "POST", "/api/admin/knowledge", upload("menu.pdf", "%PDF-1.7", { docType: "menu" }));
    expect(pdf.status).toBe(415);
    expect(pdf.json.error).toMatchObject({ code: "UNSUPPORTED_FILE" });
    const bin = await call(kb().POST, "POST", "/api/admin/knowledge", upload("notes.txt", new Uint8Array([0xc3, 0x28, 0x41, 0x42]), { docType: "other", title: "Staff notes" }));
    expect(bin.status).toBe(201);
    expect(bin.json).toMatchObject({ ok: false, error: expect.stringMatching(/isn't valid UTF-8/) });
    const d = await detail(bin.json.id);
    expect(d.document).toMatchObject({ state: "failed", failedStage: "extract", passages: 0 });
    expect(d.document.stages.map((x: { status: string }) => x.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped"]);
    expect(d.jobs[0]).toMatchObject({ kind: "ingest", status: "failed" });
    expect(docFacts()).toHaveLength(1); // the failed one contributes nothing
    expect((await overview()).counts).toMatchObject({ documents: 2, failed: 1 });
    // Retrying needs readable text; replacing the file with a good one fixes it.
    expect((await call(documentReingestHandler(s.deps), "POST", `/api/admin/knowledge/${bin.json.id}/reingest`, undefined, { id: String(bin.json.id) })).status).toBe(409);
    const fixed = await call(documentFileHandler(s.deps), "PUT", `/api/admin/knowledge/${bin.json.id}/file`, upload("notes.txt", "Staff notes: the terrace closes when it rains."), { id: String(bin.json.id) });
    expect(fixed.json.ok).toBe(true);
    expect((await detail(bin.json.id)).document.state).not.toBe("failed");
    expect(docFacts()).toHaveLength(2);
  });

  it("refuses empty, too large and duplicate documents without storing anything", async () => {
    s = await seeded("kb", NOW);
    expect((await article({ text: "   " })).json.error.fields.text).toMatch(/no readable text/);
    expect((await call(kb().POST, "POST", "/api/admin/knowledge", upload("big.txt", "a ".repeat(140_000), { docType: "other" }))).status).toBe(413);
    expect((await article()).status).toBe(201);
    expect((await article({ title: "Another title" })).json.error).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/already in the knowledge base/) });
    expect((await article({ text: "Different text about corkage, long enough to count." })).json.error.code).toBe("CONFLICT"); // same title
    expect((db().prepare("SELECT count(*) AS n FROM kb_documents").get() as { n: number }).n).toBe(1);
  });

  it("editing the text re-ingests it with no duplicate or stale passages", async () => {
    s = await seeded("kb", NOW);
    const id = (await article()).json.id;
    await settle();
    const r = await call(doc().PATCH, "PATCH", `/api/admin/knowledge/${id}`, { text: "Corkage is ₹1,200 per bottle at Golf Course Road only." }, { id: String(id) });
    expect(r.json).toMatchObject({ changed: true, summary: "text" });
    expect(docFacts().map((f) => f.id)).toEqual(["doc:corkage-policy:1"]);
    expect(db().prepare("SELECT count(*) AS n FROM kb_chunks").get()).toEqual({ n: 1 });
    expect(db().prepare("SELECT count(*) AS n FROM kb_fts WHERE fact_id LIKE 'doc:%'").get()).toEqual({ n: 1 });
    expect(db().prepare("SELECT count(*) AS n FROM fact_embeddings WHERE fact_id = 'doc:corkage-policy:2'").get()).toEqual({ n: 0 }); // the removed passage's vector went with it
    await settle();
    const cov = embeddingCoverage(db(), facts(), await fakeEmbedder().digest());
    expect(cov).toMatchObject({ missing: [], stale: [] });
    expect((await preview("corkage")).hits.filter((h: { kind: string }) => h.kind === "doc").map((h: { text: string }) => h.text)).toEqual(["Corkage policy: Corkage is ₹1,200 per bottle at Golf Course Road only."]);
    // Text that can't make a document is refused; the current version stays.
    expect((await call(doc().PATCH, "PATCH", `/api/admin/knowledge/${id}`, { text: "" }, { id: String(id) })).status).toBe(400);
    expect(docFacts()).toHaveLength(1);
  });

  it("a deactivated or deleted document stops contributing at once: no facts, keyword rows or vectors", async () => {
    s = await seeded("kb", NOW);
    const id = (await article()).json.id;
    await settle();
    await call(doc().PATCH, "PATCH", `/api/admin/knowledge/${id}`, { isActive: false }, { id: String(id) });
    expect(docFacts()).toEqual([]);
    expect(db().prepare("SELECT count(*) AS n FROM kb_fts WHERE fact_id LIKE 'doc:%'").get()).toEqual({ n: 0 });
    expect(db().prepare("SELECT count(*) AS n FROM fact_embeddings WHERE fact_id LIKE 'doc:%'").get()).toEqual({ n: 0 });
    expect((await preview("corkage")).hits.some((h: { kind: string }) => h.kind === "doc")).toBe(false);
    expect((await detail(id)).document.state).toBe("inactive");
    await call(doc().PATCH, "PATCH", `/api/admin/knowledge/${id}`, { isActive: true }, { id: String(id) });
    await settle();
    expect((await detail(id)).document.state).toBe("searchable");
    const del = await call(doc().DELETE, "DELETE", `/api/admin/knowledge/${id}`, undefined, { id: String(id) });
    expect(del.json).toMatchObject({ deleted: true, title: "Corkage policy" });
    expect(db().prepare("SELECT (SELECT count(*) FROM kb_documents) AS d, (SELECT count(*) FROM kb_chunks) AS c, (SELECT count(*) FROM kb_fts WHERE fact_id LIKE 'doc:%') AS f, (SELECT count(*) FROM fact_embeddings WHERE fact_id LIKE 'doc:%') AS v").get()).toEqual({ d: 0, c: 0, f: 0, v: 0 });
    await settle();
    expect((await overview()).index.mode).toBe("hybrid");
    expect((await call(doc().GET, "GET", `/api/admin/knowledge/${id}`, undefined, { id: String(id) })).status).toBe(404);
  });

  it("an embedding failure is reported against the document; the menu and FAQs keep their vectors; retry recovers", async () => {
    let failing = true;
    const base = fakeEmbedder();
    const flaky: Embedder = {
      provider: "fake",
      model: base.model,
      digest: () => base.digest(),
      embed: async (inputs, o) => {
        if (failing && inputs.some((i) => i.includes("Corkage"))) throw new EmbedError("EMBED_TIMEOUT", "the embedding model did not answer in time");
        return base.embed(inputs, o);
      },
    };
    s = await seeded("kb", NOW, { embedder: flaky });
    const id = (await article()).json.id;
    await call((await import("@/lib/api/admin-workspace")).menuItemHandlers(s.deps).PATCH, "PATCH", "/api/admin/menu/dal-ember", { priceInr: 465 }, { slug: "dal-ember" });
    await settle();
    const d = await detail(id);
    expect(d.document).toMatchObject({ state: "keyword_only", embedError: "EMBED_TIMEOUT: the embedding model did not answer in time" });
    expect(d.document.stages.at(-1)).toMatchObject({ key: "embed", status: "failed" });
    const o = await overview();
    expect(o.index.mode).toBe("keyword");
    expect(o.jobs.find((j: { kind: string }) => j.kind === "refresh")).toMatchObject({ status: "failed", error: expect.stringMatching(/^Document corkage-policy: EMBED_TIMEOUT/) });
    const cov = embeddingCoverage(db(), facts(), await base.digest());
    expect(cov.missing.sort()).toEqual(["doc:corkage-policy:1", "doc:corkage-policy:2"]); // the dal's new vector was stored
    expect((await retrieveFacts("corkage", {}, { db: db(), facts: facts(), embedder: base })).mode).toBe("lexical");
    failing = false;
    expect((await call(refreshHandler(s.deps), "POST", "/api/admin/knowledge/refresh")).status).toBe(202);
    await settle();
    expect((await detail(id)).document).toMatchObject({ state: "searchable", embedError: null });
    expect((await overview()).index.mode).toBe("hybrid");
  });

  it("a document for an inactive branch doesn't reach the chatbot", async () => {
    s = await seeded("kb", NOW);
    await article({ branch: "gurugram" });
    expect(docFacts()[0].text).toMatch(/^\(Golf Course Road\) Corkage policy/);
    db().prepare("UPDATE branches SET is_active = 0 WHERE slug = 'gurugram'").run();
    expect(docFacts()).toEqual([]);
  });

  it("previews retrieval honestly: validation, no matches, and which facts are never searched", async () => {
    s = await seeded("kb", NOW);
    expect((await call(previewHandler(s.deps), "POST", "/api/admin/knowledge/preview", { query: "" })).status).toBe(400);
    const p = await preview("What are the opening hours of the Hauz Khas branch?");
    expect(p.note).toMatch(/Opening hours, branch details and the restaurant description are always given to the chatbot/);
    expect(p.hits.every((h: { kind: string }) => ["menu", "faq", "menu-cat", "menu-diet", "doc"].includes(h.kind))).toBe(true);
  });
});
