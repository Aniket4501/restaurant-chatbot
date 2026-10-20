import fs from "node:fs";
import path from "node:path";
import { expect, test as base, type APIRequestContext } from "@playwright/test";
import { checkE2E, type Observed } from "./invariants";
import { E2E_NOW, serverFiles } from "./env";

// Every spec (D-12): a fresh fixture database before it, and the §6.4 invariants after it. Specs call the API through
// `api` (so reservation and cancel responses are recorded like the page's) and add anything they type to `pii`.
// The fixture callback is named `provide` (Playwright's `use`) so the React hooks lint rule doesn't mistake it for a hook.

type Server = { port: number; origin: string; db: string; trace: string; log: string };
type Api = { post(pathname: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; json: unknown; headers: Record<string, string> }> };

export const test = base.extend<{ server: Server; observed: Observed; api: Api; _reset: void; _invariants: void }>({
  server: async ({ baseURL }, provide) => {
    const port = Number(new URL(baseURL!).port);
    const f = serverFiles(port);
    await provide({ port, origin: `http://127.0.0.1:${port}`, db: path.resolve(f.db), trace: path.resolve(f.trace), log: path.resolve(f.log) });
  },
  observed: async ({}, provide) => provide({ reservationResponses: [], cancelResponses: [], renderedConfirmationRefs: [], pageTextOutsideConfirmations: "", pii: [] }),
  api: async ({ request, server, observed }, provide) => {
    await provide({
      async post(pathname, body, headers = {}) {
        const b = body as Record<string, unknown> | null;
        if (pathname === "/api/chat") for (const m of (b?.messages as { role: string; content: string }[] | undefined) ?? []) if (m.role === "guest") observed.pii.push(m.content);
        if (pathname === "/api/reservations") for (const k of ["name", "phone", "email", "note"]) if (typeof b?.[k] === "string") observed.pii.push(b[k] as string);
        const res = await (request as APIRequestContext).post(`${server.origin}${pathname}`, { headers: { origin: server.origin, "content-type": "application/json", ...headers }, data: body });
        const json = await res.json().catch(() => null);
        if (pathname === "/api/reservations") observed.reservationResponses.push({ status: res.status(), ref: (json as { reservation?: { ref: string } } | null)?.reservation?.ref ?? null, at: Date.now() });
        return { status: res.status(), json, headers: res.headers() };
      },
    });
  },
  _reset: [
    async ({ request, server }, provide) => {
      const res = await request.post(`${server.origin}/api/__test/reset`, { headers: { origin: server.origin } });
      expect(res.status(), "test reset").toBe(200);
      await provide();
    },
    { auto: true },
  ],
  _invariants: [
    async ({ page, server, observed }, provide, info) => {
      const logOffset = fs.existsSync(server.log) ? fs.statSync(server.log).size : 0;
      // Everything a guest sends counts as guest data for INV-07, whoever typed it (review UI-3).
      page.on("request", (r) => {
        const url = new URL(r.url());
        if (r.method() !== "POST") return;
        const body = (() => {
          try {
            return r.postDataJSON() as Record<string, unknown> | null;
          } catch {
            return null;
          }
        })();
        if (url.pathname === "/api/chat") for (const m of (body?.messages as { role: string; content: string }[] | undefined) ?? []) if (m.role === "guest") observed.pii.push(m.content);
        if (url.pathname === "/api/reservations") for (const k of ["name", "phone", "email", "note"]) if (typeof body?.[k] === "string") observed.pii.push(body[k] as string);
      });
      page.on("response", async (r) => {
        const url = new URL(r.url());
        const method = r.request().method();
        if (url.pathname === "/api/reservations" && method === "POST") {
          const j = await r.json().catch(() => null);
          observed.reservationResponses.push({ status: r.status(), ref: j?.reservation?.ref ?? null, at: Date.now() });
        }
        const cancel = /^\/api\/admin\/reservations\/(NE-[0-9A-Z]{8})$/.exec(url.pathname);
        if (cancel && method === "PATCH") observed.cancelResponses.push({ status: r.status(), ref: cancel[1] });
      });
      await provide();
      // INV-04's page check covers guest-facing pages (D-12); admin pages list "Confirmed" bookings by design.
      if (page.url() !== "about:blank" && !new URL(page.url()).pathname.startsWith("/admin")) {
        observed.renderedConfirmationRefs = await page.locator("[data-confirmation-ref]").evaluateAll((els) => els.map((e) => e.getAttribute("data-confirmation-ref")!));
        observed.pageTextOutsideConfirmations = await page.evaluate(() => {
          const clone = document.body.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("[data-confirmation-ref]").forEach((e) => e.remove());
          return clone.innerText;
        });
      }
      const violations = checkE2E({ db: server.db, trace: server.trace, log: server.log, logOffset }, Date.parse(E2E_NOW), observed);
      fs.mkdirSync("test-results/e2e", { recursive: true });
      fs.appendFileSync("test-results/e2e/invariants.jsonl", `${JSON.stringify({ test: info.titlePath.join(" › "), status: info.status, violations })}\n`);
      expect(violations, "§6.4 invariants").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
