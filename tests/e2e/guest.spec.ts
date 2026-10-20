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
  await page.getByRole("button", { name: `Book at ${o.branch ?? "Hauz Khas"}` }).click();
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
  await expect(page.getByRole("button", { name: "Book at Hauz Khas" })).toBeVisible();
  await axe(page, "welcome");
  await page.getByRole("button", { name: "Book at Hauz Khas" }).click();
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
  await expect(page.getByRole("button", { name: "Book at Hauz Khas" })).toBeDisabled();
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
  await expect(page.getByRole("status")).toHaveText("I'm having trouble understanding right now. You can still book using the options below.");
  await axe(page, "degraded");
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

test("J12 an answer from stored facts comes with the fact it used, and the conversation survives a reload @cat:faq", async ({ page }) => {
  await page.goto("/");
  await say(page, "can I bring my dog?");
  await expect(page.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.", { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Q: Can I bring my dog?" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Book at Golf Course Road" })).toBeVisible();
  await axe(page, "phone");
});

test("focus stays visible on the dark identity panel (WCAG 1.4.11, review UI-4)", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("link", { name: "+91 11 4155 0101" }).last();
  await link.focus();
  const ring = await link.evaluate((el) => ({ visible: el.matches(":focus-visible"), color: getComputedStyle(el).outlineColor, style: getComputedStyle(el).outlineStyle }));
  expect(ring).toEqual({ visible: true, color: "rgb(241, 235, 226)", style: "solid" });
});
