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

