import { expect, test } from "./fixtures";

// T-15 skeleton specs. The guest and admin UIs arrive in T-16 and T-17.
test("guest page renders the restaurant name", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Neem & Ember");
});

test("health: test mode, fake providers, retrieval index complete", async ({ request, server }) => {
  const j = await (await request.get(`${server.origin}/api/health`)).json();
  expect(j).toMatchObject({ ok: true, testMode: true, model: { provider: "fake", embedProvider: "fake" }, kb: { facts: 86, retrievalMode: "hybrid" } });
});

test("a scripted chat turn and a booking through the API keep every invariant", async ({ api, observed }) => {
  const sessionId = crypto.randomUUID();
  const faq = await api.post("/api/chat", { sessionId, messages: [{ role: "guest", content: "can I bring my dog?" }], draft: null });
  expect(faq.status).toBe(200);
  expect(faq.json).toMatchObject({ meta: { outcome: "faq_answer" }, reply: { text: "Well-behaved dogs are welcome on the Golf Course Road terrace." } });

  const turn = await api.post("/api/chat", { sessionId, messages: [{ role: "guest", content: "table for 4 tomorrow at 8pm in Hauz Khas" }], draft: null });
  const confirm = (turn.json as { reply: { blocks: { type: string; startsAtMs?: number }[] } }).reply.blocks.find((b) => b.type === "confirm")!;
  expect(confirm).toBeDefined();
  observed.pii.push("Asha Rao", "98765 43210");
  const res = await api.post("/api/reservations", { branch: "hauz-khas", startsAt: confirm.startsAtMs, partySize: 4, name: "Asha Rao", phone: "98765 43210" }, { "idempotency-key": crypto.randomUUID() });
  expect(res.status).toBe(201);
});
