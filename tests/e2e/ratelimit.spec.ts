import { PORTS } from "./env";
import { expect, test } from "./fixtures";

// The low-limit server (3 turns per minute, D-12) gives 429 with Retry-After; the reset clears the limits.
test.use({ baseURL: `http://127.0.0.1:${PORTS.lowLimit}` });

test("chat turns beyond the limit get 429 RATE_LIMITED with Retry-After", async ({ api }) => {
  const turn = () => api.post("/api/chat", { sessionId: crypto.randomUUID(), messages: [{ role: "guest", content: "hello" }], draft: null });
  for (let i = 0; i < 3; i++) expect((await turn()).status).toBe(200);
  const limited = await turn();
  expect(limited.status).toBe(429);
  expect(limited.json).toMatchObject({ error: { code: "RATE_LIMITED" } });
  expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
});

test("the reset before each spec clears the limits", async ({ api }) => {
  expect((await api.post("/api/chat", { sessionId: crypto.randomUUID(), messages: [{ role: "guest", content: "hello" }], draft: null })).status).toBe(200);
});
