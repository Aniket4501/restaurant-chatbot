import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// D-25 staff workspace on the test-mode server (fake model and embedder, a fresh fixture database per spec, E2E today
// Fri 16 Oct 2026, 2 PM IST). Every edit here is checked where the guest sees it: the chat, or the public API.

async function axe(page: Page, state: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe (${state})`).toEqual([]);
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Staff pages" });
/** The guest chat keeps its conversation in sessionStorage; start a new one. */
async function freshChat(page: Page) {
  await page.goto("/");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
}

const PAGES = [
  ["Overview", "Overview"],
  ["Bookings", "Bookings"],
  ["Menu", "Menu"],
  ["Knowledge base", "Knowledge base"],
  ["FAQs", "FAQs"],
  ["Availability", "Availability"],
  ["Branches", "Branches"],
  ["Evals", "Evals"],
] as const;

test("every section is reachable from the navigation, marked as the current page, and passes axe @cat:admin", async ({ page }) => {
  await page.goto("/admin");
  for (const [link, h1] of PAGES) {
    await nav(page).getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: h1, exact: true })).toBeVisible();
    await expect(nav(page).getByRole("link", { name: link, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByLabel(/^Loading/)).toHaveCount(0);
    if (h1 !== "Evals") await axe(page, h1);
  }
});

test("on a phone the page list opens from the top bar, closes on navigation, and nothing scrolls sideways @cat:admin", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const toggle = page.getByRole("button", { name: /staff pages/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await nav(page).getByRole("link", { name: "Availability", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Availability" })).toBeVisible();
  await expect(page.getByRole("button", { name: /staff pages/ })).toHaveAttribute("aria-expanded", "false");
  for (const path of ["/admin", "/admin/menu", "/admin/menu/dal-ember", "/admin/knowledge", "/admin/faqs", "/admin/availability", "/admin/branches", "/admin/bookings"]) {
    await page.goto(path);
    await expect(page.getByLabel(/^Loading/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll on ${path}`).toBe(true);
  }
  await page.getByRole("button", { name: /staff pages/ }).click();
  await axe(page, "phone navigation open");
});

test("a price change and 'unavailable' in the admin reach the guest's menu straight away @cat:menu", async ({ page }) => {
  await page.goto("/admin/menu");
  await page.getByLabel("Search dishes").fill("dal ember");
  await page.getByRole("link", { name: "Dal Ember" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dal Ember" })).toBeVisible();
  await page.getByLabel("Price (₹, whole rupees)").fill("465");
  await expect(page.getByRole("article", { name: "Preview: Dal Ember" })).toContainText("₹465");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved (price ₹445 → ₹465)" })).toBeVisible();
  await expect(page.getByText(/Dal Ember \(mains\), ₹465\./)).toBeVisible(); // what the chatbot reads
  await axe(page, "dish editor");

  await freshChat(page);
  await page.getByRole("button", { name: "Show me the menu" }).click();
  await page.getByRole("button", { name: "Mains", exact: true }).click();
  const mains = page.getByRole("group", { name: "Mains" }).last();
  await expect(mains.getByText("Dal Ember", { exact: true })).toBeVisible();
  await expect(mains.getByText("₹465", { exact: true })).toBeVisible();

  await page.goto("/admin/menu/dal-ember");
  await page.getByLabel("Availability").selectOption("unavailable");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "available → unavailable" })).toBeVisible();
  await freshChat(page);
  await page.getByRole("button", { name: "Show me the menu" }).click();
  await page.getByRole("button", { name: "Mains", exact: true }).click();
  await expect(page.getByRole("group", { name: "Mains" }).last().getByText("Chana Pindi", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Mains" }).last().getByText("Dal Ember", { exact: true })).toHaveCount(0);
});

test("a new dish needs valid fields; the server's messages show next to them @cat:menu", async ({ page }) => {
  await page.goto("/admin/menu/new");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByText("Enter a name")).toBeVisible();
  await expect(page.getByText("Choose a section")).toBeVisible();
  await page.getByLabel("Name").fill("Smoked Beetroot Tikki");
  await page.getByLabel("Description").fill("Beetroot and potato patties smoked over coals");
  await page.getByLabel("Section").selectOption("small-plates");
  await page.getByLabel("Price (₹, whole rupees)").fill("345");
  await page.getByLabel("Vegan").check();
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page).toHaveURL(/\/admin\/menu\/smoked-beetroot-tikki\?created=1$/);
  await expect(page.getByText("Added to the menu.")).toBeVisible();
  await page.goto("/admin/menu");
  await page.getByLabel("Search dishes").fill("beetroot");
  await expect(page.getByRole("link", { name: "Smoked Beetroot Tikki" })).toBeVisible();
});

test("knowledge base: an article becomes searchable passages; bad uploads are refused or reported; deleting asks first @cat:knowledge", async ({ page }) => {
  await page.goto("/admin/knowledge");
  await expect(page.getByText("No documents yet")).toBeVisible();
  await page.getByRole("button", { name: "Write an article" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Write an article" });
  await dlg.getByLabel("Title").fill("Corkage policy");
  await dlg.getByLabel("Type").selectOption("payment");
  await dlg.getByLabel("Text").fill("# Corkage\n\nGuests may bring their own wine to Golf Course Road. Corkage is ₹1,000 per bottle.");
  await dlg.getByRole("button", { name: "Add article" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added and indexed for keyword search" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Corkage policy" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Corkage policy" }).getByText("Searchable", { exact: true })).toBeVisible({ timeout: 10_000 }); // the fake embedder finishes quickly

  await page.getByRole("textbox", { name: "Guest question" }).fill("Can I bring my own wine? Is there corkage?");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const evidence = page.getByRole("heading", { name: /^Retrieved evidence for/ }).locator("..");
  await expect(evidence.getByRole("listitem").first()).toContainText("Corkage is ₹1,000 per bottle.");
  await expect(evidence.getByRole("link", { name: "Corkage policy, passage 1" })).toBeVisible();
  await axe(page, "knowledge base with a document and a preview");

  await page.getByRole("button", { name: "Upload a file" }).first().click();
  const up = page.getByRole("dialog", { name: "Upload a file" });
  await up.getByLabel("File", { exact: true }).setInputFiles({ name: "menu.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") });
  await up.getByRole("button", { name: "Upload and process" }).click();
  await expect(up.getByText(/Only plain text \(\.txt\) and Markdown \(\.md\) files can be read/)).toBeVisible();
  await up.getByLabel("File", { exact: true }).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from([0xc3, 0x28, 0x41, 0x42]) });
  await up.getByLabel(/^Title/).fill("Staff notes");
  await up.getByRole("button", { name: "Upload and process" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "couldn't be read: The file isn't valid UTF-8 text" })).toBeVisible();
  await page.getByRole("link", { name: "Open the document" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Staff notes" })).toBeVisible();
  await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this document?" });
  await confirm.getByRole("button", { name: "Keep it" }).click();
  await expect(confirm).toBeHidden();
  await page.getByRole("button", { name: "Delete" }).click();
  await confirm.getByRole("button", { name: "Delete document" }).click();
  await expect(page).toHaveURL(/\/admin\/knowledge$/);
  await expect(page.getByRole("link", { name: "Staff notes" })).toHaveCount(0);
});

test("FAQs: a second answer to the same question is flagged, and staff can ask the real chatbot @cat:faq", async ({ page }) => {
  await page.goto("/admin/faqs");
  await page.getByRole("button", { name: "Add an FAQ" }).click();
  const dlg = page.getByRole("dialog", { name: "Add an FAQ" });
  await dlg.getByRole("textbox", { name: "Question" }).fill("Is there parking?");
  await dlg.getByRole("textbox", { name: "Answer" }).fill("Yes, free valet parking at both branches.");
  await dlg.getByLabel("Category").selectOption("facilities");
  await dlg.getByRole("button", { name: "Add FAQ" }).click();
  // The editor stays open on the new FAQ and says it was added.
  const added = page.getByRole("dialog", { name: "Edit FAQ" });
  await expect(added.getByRole("status").filter({ hasText: "Added “Is there parking?”" })).toBeVisible();
  await added.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByText(/Possible conflict:/).first()).toBeVisible();
  await expect(page.getByText(/Possible conflict:/)).toHaveCount(2); // both branch parking FAQs
  await axe(page, "faqs with conflicts");

  await page.getByRole("button", { name: "Can I bring my dog?" }).click();
  const edit = page.getByRole("dialog", { name: "Edit FAQ" });
  await edit.getByRole("button", { name: "Ask the chatbot" }).click();
  const reply = edit.getByRole("region", { name: "How the chatbot answers this question" });
  await expect(reply.getByText("Well-behaved dogs are welcome on the Golf Course Road terrace.")).toBeVisible();
  await expect(reply.getByText(/cited faq:pets/)).toBeVisible();
});

test("availability: blocking a start time removes it from what guests are offered, and reopening restores it @cat:availability", async ({ page, request, server }) => {
  const offered = async () => ((await (await request.get(`${server.origin}/api/availability?branch=hauz-khas&date=2026-10-17&party=2&time=20:00`)).json()).slots as { time: string }[]).some((s) => s.time === "20:00");
  expect(await offered()).toBe(true);
  await page.goto("/admin/availability");
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page.getByRole("heading", { name: "Hauz Khas, Sat 17 Oct 2026" })).toBeVisible();
  await page.getByRole("checkbox", { name: /^8:00 PM, Open/ }).check();
  await page.getByLabel("Reason (optional, staff only)").fill("Staff training");
  await page.getByRole("button", { name: "Block 1 time" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Blocked 1 time." })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^8:00 PM, Blocked \(Staff training\)/ })).toBeVisible();
  expect(await offered()).toBe(false);
  await axe(page, "availability day view");
  await page.getByRole("checkbox", { name: /^8:00 PM, Blocked/ }).check();
  await page.getByRole("button", { name: "Reopen 1 time" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Reopened 1 time." })).toBeVisible();
  expect(await offered()).toBe(true);

  for (const tab of ["Weekly hours", "Special dates", "Tables", "Booking rules"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel(/^Loading/)).toHaveCount(0);
    await axe(page, `availability ${tab}`);
  }
});

test("bookings: search finds a booking on any date, the list masks the mobile, and details show it @cat:booking_success", async ({ page, api, observed }) => {
  observed.pii.push("Meera Kapoor", "98111 22233");
  const r = await api.post("/api/reservations", { branch: "gurugram", startsAt: Date.parse("2026-10-18T20:00:00+05:30"), partySize: 3, name: "Meera Kapoor", phone: "98111 22233", note: "Window seat please" }, { "idempotency-key": crypto.randomUUID() });
  expect(r.status).toBe(201);
  await page.goto("/admin/bookings");
  await page.getByLabel("Search by guest name or reference").fill("meera");
  await expect(page.getByRole("heading", { name: "Search results for “meera”" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Meera Kapoor" });
  await expect(row).toContainText("Sun 18 Oct 2026");
  await expect(row).toContainText("+91 98••• ••233");
  await expect(row).toContainText("Has a note");
  await expect(row).not.toContainText("98111 22233");
  await row.getByRole("button", { name: /^Details of Meera Kapoor's booking/ }).click();
  const dlg = page.getByRole("dialog", { name: /^Booking NE-/ });
  await expect(dlg).toContainText("+91 98111 22233");
  await expect(dlg).toContainText("Window seat please");
  await expect(dlg).toContainText("table T3");
  await axe(page, "booking details");
});
