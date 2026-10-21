import AxeBuilder from "@axe-core/playwright";
import Database from "better-sqlite3";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Guest UI journeys (T-16, §5.10) on the test-mode server with the fake model (tests/e2e/fake-script.json).
// Every spec ends with the §6.4 invariants (fixtures.ts); axe runs on each state a spec reaches.

const rows = (db: string) => {
  const d = new Database(db, { readonly: true });
  try {
    return d.prepare("SELECT ref, status, party_size AS party FROM reservations ORDER BY created_at").all() as { ref: string; status: string; party: number }[];
  } finally {
    d.close();
  }
};

async function axe(page: Page, state: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe (${state})`).toEqual([]);
}

async function chipsToConfirm(page: Page, o: { branch?: string; date?: string; party?: string; time?: string } = {}) {
  await page.getByRole("button", { name: "Find a table" }).click();
  await page.getByRole("button", { name: o.branch ?? "Hauz Khas", exact: true }).click();
  await page.getByRole("button", { name: o.date ?? "Tomorrow, Sat 17 Oct" }).click();
  await page.getByRole("button", { name: o.party ?? "4 guests", exact: true }).click();
  await page.getByRole("button", { name: o.time ?? "7:30 PM", exact: true }).last().click();
  await expect(page.getByRole("form", { name: "Confirm your booking" }).last()).toBeVisible();
}

async function fillDetails(page: Page, name = "Asha Rao", phone = "+91 98765 43210") {
  const form = page.getByRole("form", { name: "Confirm your booking" }).last();
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Mobile number").fill(phone);
  return form;
}

const say = async (page: Page, text: string) => {
  await page.getByLabel("Your message").fill(text);
  await page.getByLabel("Your message").press("Enter");
};

test("J3 chips only: branch, date, party, time and details give a confirmation from the saved row @cat:booking_success", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Find a table" })).toBeVisible();
  await axe(page, "welcome");
  await page.getByRole("button", { name: "Find a table" }).click();
  await page.getByRole("button", { name: "Hauz Khas", exact: true }).click();
  await page.getByRole("button", { name: "Tomorrow, Sat 17 Oct" }).click();
  await page.getByRole("button", { name: "4 guests", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sat 17 Oct · Hauz Khas · 4 guests" })).toBeVisible();
  await axe(page, "slots");
  await page.getByRole("button", { name: "7:30 PM", exact: true }).last().click();
  await expect(page.getByRole("form", { name: "Confirm your booking" })).toBeVisible();
  await axe(page, "confirm");
  await (await fillDetails(page)).getByRole("button", { name: "Confirm" }).click();
  const card = page.locator("[data-confirmation-ref]");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Sat 17 Oct 2026, 7:30 PM");
  await expect(card).toContainText("+91 11 4155 0101");
  expect(rows(server.db)).toEqual([{ ref: await card.getAttribute("data-confirmation-ref"), status: "confirmed", party: 4 }]);
  await axe(page, "confirmation");
});

test("J3 typed only: one message with every detail goes straight to the confirm card @cat:booking_success", async ({ page, server, observed }) => {
  observed.pii.push("Ravi Kumar", "99887 76655");
  await page.goto("/");
  await say(page, "table for 4 tomorrow at 8pm in Hauz Khas");
  await expect(page.getByRole("heading", { name: "Sat 17 Oct 2026, 8:00 PM" })).toBeVisible();
  await (await fillDetails(page, "Ravi Kumar", "99887 76655")).getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("[data-confirmation-ref]")).toContainText("Sat 17 Oct 2026, 8:00 PM");
  expect(rows(server.db)).toHaveLength(1);
});

test("J4 a full time is not offered; the nearest times and other options are @cat:slot_unavailable", async ({ page, api }) => {
  for (const phone of ["98100 00001", "98100 00002", "98100 00003"])
    expect((await api.post("/api/reservations", { branch: "hauz-khas", startsAt: Date.parse("2026-10-17T20:00:00+05:30"), partySize: 4, name: "Other Guest", phone }, { "idempotency-key": crypto.randomUUID() })).status).toBe(201);
  await page.goto("/");
  await say(page, "table for 4 tomorrow at 8pm in Hauz Khas");
  await expect(page.getByText("8:00 PM isn't available. Here are the nearest open times.")).toBeVisible();
  const picker = page.getByRole("region", { name: "Sat 17 Oct · Hauz Khas · 4 guests" });
  await expect(picker.getByRole("button", { name: "8:00 PM", exact: true })).toHaveCount(0);
  await expect(picker.getByRole("heading", { name: "Other options" })).toBeVisible();
  await axe(page, "slots with alternatives");
});

test("J6 a double tap on Confirm books once @cat:retry_after_timeout", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await chipsToConfirm(page);
  await (await fillDetails(page)).getByRole("button", { name: "Confirm" }).dblclick();
  await expect(page.locator("[data-confirmation-ref]")).toHaveCount(1);
  expect(rows(server.db)).toHaveLength(1);
});

test("J6 a lost response locks the card; Retry with the same key shows the same booking @cat:context_loss", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await chipsToConfirm(page);
  await page.route("**/api/reservations", async (route) => {
    await route.fetch(); // the server saves the booking…
    await route.abort("failed"); // …but the response never arrives
  }, { times: 1 });
  const form = await fillDetails(page);
  await form.getByRole("button", { name: "Confirm" }).click();
  await expect(form.getByRole("alert")).toContainText("We couldn't reach the restaurant to confirm your booking");
  await expect(form.getByLabel("Name")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Find a table" })).toBeDisabled();
  await expect(page.getByLabel("Your message")).toBeDisabled(); // nothing can strand the locked card (review UI-1)
  await axe(page, "pending submit");
  await form.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("[data-confirmation-ref]")).toBeVisible();
  expect(rows(server.db)).toHaveLength(1);
  expect(observed.reservationResponses.map((r) => r.status)).toEqual([200]); // the replay of the saved booking
});

test("J6 reloading with a submit in flight replays it and shows the booking @cat:context_loss", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await chipsToConfirm(page);
  await page.route("**/api/reservations", async (route) => {
    await route.fetch();
    await route.abort("failed");
  }, { times: 1 });
  await (await fillDetails(page)).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-confirmation-ref]")).toBeVisible();
  expect(rows(server.db)).toHaveLength(1);
});

test("J7 the same mobile at an overlapping time: the existing booking is shown only when the name matches @cat:duplicate", async ({ page, api, server, observed }) => {
  observed.pii.push("Asha Rao", "asha rao", "Meera Iyer", "98765 43210");
  const first = await api.post("/api/reservations", { branch: "hauz-khas", startsAt: Date.parse("2026-10-17T20:00:00+05:30"), partySize: 2, name: "Asha Rao", phone: "98765 43210" }, { "idempotency-key": crypto.randomUUID() });
  const ref = (first.json as { reservation: { ref: string } }).reservation.ref;
  await page.goto("/");
  await chipsToConfirm(page, { party: "2 guests", time: "8:00 PM" });
  await (await fillDetails(page, "asha rao")).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(`You already have a table at 8:00 PM on Sat 17 Oct 2026 (ref ${ref}).`)).toBeVisible();

  await page.getByRole("button", { name: "New conversation" }).click();
  await chipsToConfirm(page, { party: "2 guests", time: "8:00 PM" });
  await (await fillDetails(page, "Meera Iyer")).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("This mobile already has a booking around this time. Please call Hauz Khas on +91 11 4155 0101.")).toBeVisible();
  await expect(page.getByText(ref)).toHaveCount(0); // the generic message never shows the other booking's ref
  expect(rows(server.db)).toHaveLength(1);
});

test("J9 and AC-10: with the model down, booking still works through the chips @cat:backend_failure", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await say(page, "book a table #fake:down");
  const msg = "I couldn't work that out just now. You can browse the menu or book a table with the buttons below, or ask again in a moment.";
  await expect(page.getByText(msg)).toHaveCount(1); // once: no notice repeating it (user report, D-20)
  await axe(page, "degraded");
  await page.getByRole("button", { name: "Find a table" }).last().click();
  await page.getByRole("button", { name: "Hauz Khas", exact: true }).click();
  await page.getByRole("button", { name: "Tomorrow, Sat 17 Oct" }).click();
  await page.getByRole("button", { name: "2 guests", exact: true }).click();
  await page.getByRole("button", { name: "7:00 PM", exact: true }).last().click();
  await (await fillDetails(page)).getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("[data-confirmation-ref]")).toBeVisible();
  expect(rows(server.db)).toHaveLength(1);
});

test("a slow reply says it's still working, then shows the answer (D-23) @cat:backend_failure", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  // Hold the reply for 10 seconds, as when the local model has to load first.
  await page.route("**/api/chat", async (route) => {
    await new Promise((r) => setTimeout(r, 10_000));
    await route.continue();
  }, { times: 1 });
  await say(page, "can I bring my dog?");
  const waiting = page.getByLabel("Checking");
  await expect(waiting).toHaveText("Checking…");
  await expect(waiting).toHaveText("Still working on it, one moment…", { timeout: 12_000 });
  await axe(page, "slow reply");
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.").first()).toBeVisible({ timeout: 20_000 });
  await expect(waiting).toHaveCount(0);
});

test("a failed chat request says so and can be retried @cat:backend_failure", async ({ page }) => {
  await page.goto("/");
  await page.route("**/api/chat", (route) => route.abort("failed"), { times: 1 });
  await say(page, "can I bring my dog?");
  const alert = page.getByRole("alert").filter({ hasText: "We couldn't reach the restaurant just now." });
  await expect(alert).toBeVisible();
  await axe(page, "chat error");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.").first()).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("J12 an answer from stored facts is shown once, with no card repeating it, and survives a reload @cat:faq", async ({ page }) => {
  await page.goto("/");
  await say(page, "can I bring my dog?");
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/^Q: /)).toHaveCount(0); // D-20: the raw fact card duplicated every answer
  await axe(page, "faq answer");
  await page.reload();
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.", { exact: true })).toBeVisible();
  await expect(page.getByText("can I bring my dog?", { exact: true })).toBeVisible();
});

test("on a phone the chat is the page and the hours fold away", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Neem & Ember");
  await expect(page.getByText("Hours and locations")).toBeVisible();
  for (const name of ["Help me find a dish", "Show me the menu", "Find a table", "Recommend something vegetarian"]) await expect(page.getByRole("button", { name })).toBeVisible();
  await axe(page, "phone");
});

test("focus stays visible on the dark identity panel (WCAG 1.4.11, review UI-4)", async ({ page }) => {
  await page.goto("/");
  // The branch phones sit in the hero's disclosure (mobile-first); open it from the keyboard, as a keyboard user would.
  await page.getByText("Hours and locations").focus();
  await page.keyboard.press("Enter");
  const link = page.getByRole("link", { name: "+91 11 4155 0101" }).last();
  await link.focus();
  const ring = await link.evaluate((el) => ({ visible: el.matches(":focus-visible"), color: getComputedStyle(el).outlineColor, style: getComputedStyle(el).outlineStyle }));
  expect(ring).toEqual({ visible: true, color: "rgb(245, 241, 232)", style: "solid" }); // --smoke-ink
});

test("the welcome offers four starting points; the menu opens without the model and lists real dishes @cat:menu", async ({ page }) => {
  await page.goto("/");
  for (const name of ["Help me find a dish", "Show me the menu", "Find a table", "Recommend something vegetarian"]) await expect(page.getByRole("button", { name })).toBeVisible();
  await page.getByRole("button", { name: "Show me the menu" }).click();
  await expect(page.getByText("Which part of the menu would you like to see?")).toBeVisible();
  await page.getByRole("button", { name: "Desserts", exact: true }).click();
  const desserts = page.getByRole("group", { name: "Desserts" });
  await expect(desserts.getByText("Mango Sorbet", { exact: true })).toBeVisible();
  await expect(desserts.getByText("₹245", { exact: true })).toBeVisible();
  await expect(page.getByText(/cheapest first|available\)/)).toHaveCount(0);
  await axe(page, "menu section");
});

test("a recommendation is a card built from the menu table, with follow-ups @cat:recommendation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Recommend something vegetarian" }).click();
  await expect(page.getByText(/^I'd suggest the Dal Ember at ₹445/)).toBeVisible();
  const card = page.getByRole("article", { name: "Dal Ember, ₹445" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Vegetarian", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Also worth a look" }).getByText("Chana Pindi", { exact: true })).toBeVisible();
  for (const name of ["Something cheaper", "Another option", "Find a table"]) await expect(page.getByRole("button", { name }).last()).toBeEnabled();
  await axe(page, "recommendation");
});

test("'Help me find a dish' asks one diet question, and an answer chip goes to the chooser (D-24, D-26) @cat:recommendation", async ({ page }) => {
  const bodies: { action?: unknown }[] = [];
  page.on("request", (r) => r.url().endsWith("/api/chat") && bodies.push(r.postDataJSON()));
  await page.goto("/");
  await page.getByRole("button", { name: "Help me find a dish" }).click();
  await expect(page.getByText("Happy to help. Any preference: vegetarian, vegan, or do you eat everything?")).toBeVisible();
  for (const name of ["Vegetarian", "Vegan", "I eat everything", "Surprise me"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await axe(page, "help question");
  await page.getByRole("button", { name: "Surprise me", exact: true }).click();
  await expect(page.getByRole("article", { name: "Chana Pindi, ₹395" })).toBeVisible();
  expect(bodies.map((b) => b.action)).toEqual([{ type: "recommend", text: "Help me find a dish" }, { type: "recommend", text: "Surprise me" }]);
});

test("a busy server's 429 shows its message with Try again, which sends the same request (D-24) @cat:backend_failure", async ({ page }) => {
  const ids: string[] = [];
  await page.route("**/api/chat", async (route) => {
    ids.push(route.request().postDataJSON().requestId);
    if (ids.length === 1) await route.fulfill({ status: 429, contentType: "application/json", headers: { "retry-after": "1" }, body: JSON.stringify({ error: { code: "RATE_LIMITED", message: "We're answering a lot of guests right now. Please try again in a moment." } }) });
    else await route.continue();
  });
  await page.goto("/");
  await say(page, "can I bring my dog?");
  const alert = page.getByRole("alert").filter({ hasText: "We're answering a lot of guests right now." });
  await expect(alert).toBeVisible();
  await axe(page, "busy");
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.").first()).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

test("Start over on a locked card starts again once the replay says nothing was booked (D-24 audit) @cat:context_loss", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  let posts = 0;
  await page.route("**/api/reservations", async (route) => {
    posts += 1;
    if (posts === 1) await route.abort("failed"); // the outcome is unknown: the card locks
    else await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "SLOT_TAKEN", message: "That time was just taken.", alternatives: [] } }) });
  });
  await page.goto("/");
  await chipsToConfirm(page);
  await (await fillDetails(page)).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("button", { name: "Start over" })).toBeVisible();
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByText("Let's start again. What would you like to do?")).toBeVisible();
  expect(posts).toBe(2); // the replay with the same key learned the outcome first
  expect(rows(server.db)).toHaveLength(0);
});

test("one guest action sends one chat request, even when tapped twice (D-20) @cat:duplicate", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/chat", async (route) => {
    requests += 1;
    await route.continue();
  });
  await page.goto("/");
  // Two clicks in the same task, before React re-renders the button as disabled: only the synchronous in-flight
  // guard can stop the second (review: a dblclick could pass on the disabled state alone).
  await page.getByRole("button", { name: "Recommend something vegetarian" }).evaluate((el: HTMLElement) => {
    el.click();
    el.click();
  });
  await expect(page.getByText(/^I'd suggest the Dal Ember/)).toHaveCount(1);
  await expect(page.getByText("Recommend something vegetarian", { exact: true }).locator("xpath=self::p")).toHaveCount(1); // one guest bubble
  expect(requests).toBe(1);
});

test("a chat turn cut off by a reload offers Try again, which resends the same request id (D-20) @cat:context_loss", async ({ page }) => {
  const bodies: { requestId?: string }[] = [];
  let held: import("@playwright/test").Route | null = null;
  await page.route("**/api/chat", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) held = route; // the first request never answers: the page is reloaded meanwhile
    else await route.continue();
  });
  await page.goto("/");
  await say(page, "can I bring my dog?");
  await expect.poll(() => bodies.length).toBe(1);
  await page.reload();
  await (held as import("@playwright/test").Route | null)?.abort().catch(() => undefined);
  await expect(page.getByRole("alert").filter({ hasText: "We couldn't reach the restaurant just now." })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.").first()).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1].requestId).toBeTruthy();
  expect(bodies[1].requestId).toBe(bodies[0].requestId);
});

test("during a booking, a suggestion keeps the booking: no 'Find a table', and its chips wait for the submit (D-20) @cat:recommendation", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await chipsToConfirm(page);
  await say(page, "Recommend something vegetarian");
  await expect(page.getByRole("article", { name: "Dal Ember, ₹445" })).toBeVisible();
  const cheaper = page.getByRole("button", { name: "Something cheaper" }).last();
  await expect(cheaper).toBeEnabled();
  await expect(page.getByRole("button", { name: "Find a table" })).toHaveCount(1); // the welcome's, not a follow-up
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/reservations", async (route) => {
    await gate;
    await route.continue();
  }, { times: 1 });
  const chats: string[] = [];
  page.on("request", (r) => r.url().endsWith("/api/chat") && chats.push(r.url()));
  await (await fillDetails(page)).getByRole("button", { name: "Confirm" }).click();
  await expect(cheaper).toBeDisabled(); // the submit is in flight: a tap here could rewrite the card
  await cheaper.click({ force: true });
  expect(chats).toEqual([]);
  release();
  await expect(page.locator("[data-confirmation-ref]")).toBeVisible();
  expect(rows(server.db)).toHaveLength(1);
  expect(chats).toEqual([]);
});

test("J6 a reload while a submit is in flight treats the replay as uncertain: a busy server keeps the card locked (review) @cat:context_loss", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await chipsToConfirm(page);
  let held: import("@playwright/test").Route | null = null;
  let calls = 0;
  await page.route("**/api/reservations", async (route) => {
    calls += 1;
    if (calls === 1) held = route; // in flight when the page reloads
    else if (calls === 2) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "BUSY", message: "Busy" } }) });
    else await route.continue();
  });
  await (await fillDetails(page)).getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => calls).toBe(1);
  // The tab dies before the failure is recorded (a reload cancels the request, and the page usually marks the submit
  // uncertain before it unloads): the stored submit still says "not uncertain", so only the replay rule protects it.
  await page.addInitScript(() => {
    const raw = sessionStorage.getItem("neem-ember-chat-v1");
    const s = raw ? JSON.parse(raw) : null;
    if (s?.pending) sessionStorage.setItem("neem-ember-chat-v1", JSON.stringify({ ...s, pending: { ...s.pending, unknown: false } }));
  });
  await page.reload();
  await (held as import("@playwright/test").Route | null)?.abort().catch(() => undefined);
  await expect(page.getByText("We still couldn't confirm whether your booking went through. Tap Retry in a moment.")).toBeVisible();
  await expect(page.getByLabel("Your message")).toBeDisabled();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("[data-confirmation-ref]")).toBeVisible();
  expect(rows(server.db)).toHaveLength(1);
});

test("the name and mobile typed into the confirm card survive a question and a reload (D-21 audit) @cat:booking_success", async ({ page, server, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await chipsToConfirm(page);
  await fillDetails(page);
  await say(page, "can I bring my dog?"); // the card is shown again under the answer
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.").first()).toBeVisible();
  const card = page.getByRole("form", { name: "Confirm your booking" }).last();
  await expect(card.getByLabel("Name")).toHaveValue("Asha Rao");
  await expect(card.getByLabel("Mobile number")).toHaveValue("+91 98765 43210");
  await page.reload();
  const again = page.getByRole("form", { name: "Confirm your booking" }).last();
  await expect(again.getByLabel("Name")).toHaveValue("Asha Rao");
  await again.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("[data-confirmation-ref]")).toBeVisible();
  expect(rows(server.db)).toHaveLength(1);
});

// D-27 and D-28 cards on a phone: structured rows, no sideways scrolling, no raw data, accessible.
// The conversation scrolls inside a clipped frame, so its own width is checked too (failure-mode audit FM-017: the page
// check alone could not see a long token widening the conversation).
const noOverflow = async (page: Page) =>
  expect(
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>("section[aria-label='Reservations and questions'] > div.overflow-y-auto");
      return document.documentElement.scrollWidth <= window.innerWidth && !!scroller && scroller.scrollWidth <= scroller.clientWidth;
    }),
  ).toBe(true);

test("opening hours: a general question shows both branches compactly; a special date shows that day only (D-27) @cat:hours", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await say(page, "What are your opening hours?");
  await expect(page.getByText("Here are the regular opening hours at both branches.")).toBeVisible();
  const week = page.getByRole("region", { name: "Golf Course Road" }).last();
  await expect(week.getByText("12:00 PM – 3:30 PM")).toBeVisible();
  await expect(week.getByText("Mondays: closed")).toBeVisible();
  await expect(page.getByRole("region", { name: "Hauz Khas" }).last().getByText("Every day")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("27 Oct");
  await noOverflow(page);
  await axe(page, "hours card");
  await say(page, "Is Hauz Khas open for dinner on 22 October?");
  await expect(page.getByText("Hauz Khas is closed for dinner on Thursday.")).toBeVisible();
  const day = page.getByRole("region", { name: "Hauz Khas" }).last();
  await expect(day.getByText("Thu 22 Oct")).toBeVisible();
  await expect(day.getByText("Closed for a private event")).toBeVisible();
  await expect(day).not.toContainText("7:00 PM");
  await expect(page.locator("body")).not.toContainText(/exception:|hours:hauz|\{"/);
  await noOverflow(page);
});

test("a meal for two within a budget: the plan card with portions and the total from code (D-28) @cat:recommendation", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await say(page, "There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?");
  await expect(page.getByText(/^Here's a vegetarian meal for two people that comes to ₹970, within your ₹1,000\./)).toBeVisible();
  const plan = page.getByRole("region", { name: "Meal for 2" });
  for (const dish of ["Dal Ember", "Yellow Dal Tadka"]) await expect(plan.getByText(dish, { exact: true })).toBeVisible();
  await expect(plan.getByText("2 × Tandoori Roti")).toBeVisible(); // one bread each, set by code
  await expect(plan.getByText("₹75 each", { exact: false })).toBeVisible();
  await expect(plan.getByText("₹970", { exact: true })).toBeVisible();
  await expect(plan.getByText("Within your budget, ₹30 to spare")).toBeVisible();
  await expect(plan.getByText("No service charge is added to the bill. Tipping is optional.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make it cheaper" })).toBeEnabled();
  await noOverflow(page);
  await axe(page, "meal plan");
});

// Failure-mode audit (evals/failure-modes.json): client recovery and layout.
test("FM-017 a long pasted link wraps inside the conversation on a 360 px phone @cat:frontend", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await say(page, `https://example.com/${"a".repeat(240)}?ref=menu`);
  await expect(page.getByText(/^https:\/\/example\.com\//)).toBeVisible();
  await expect(page.getByText(/^Sorry, I didn't quite get that\./)).toBeVisible();
  await noOverflow(page);
});

test("FM-016 a refused booking clears an older chat turn's Try again, so it can't bring back a stale card @cat:duplicate", async ({ page, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await chipsToConfirm(page);
  await page.route("**/api/chat", (route) => route.abort("failed"), { times: 1 });
  await say(page, "can I bring my dog?");
  const alert = page.getByRole("alert").filter({ hasText: "We couldn't reach the restaurant just now." });
  await expect(alert).toBeVisible();
  await page.route("**/api/reservations", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "SLOT_TAKEN", message: "That time was just taken.", alternatives: [] } }) }));
  await (await fillDetails(page)).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(/^Sorry, that time was just taken\./)).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("FM-015 a chat request with no reply is given up after 90 s with Try again, which then answers @cat:backend_failure", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  let held = true;
  await page.route("**/api/chat", async (route) => {
    if (held) return; // never answered
    await route.continue();
  });
  await say(page, "can I bring my dog?");
  await expect(page.getByRole("button", { name: "New conversation" })).toBeDisabled();
  await page.clock.fastForward(91_000);
  const alert = page.getByRole("alert").filter({ hasText: "This is taking much longer than usual." });
  await expect(alert).toBeVisible();
  held = false;
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.").first()).toBeVisible();
  await expect(alert).toHaveCount(0);
});

