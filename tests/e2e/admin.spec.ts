import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { E2E_ADMIN, PORTS } from "./env";
import { expect, test } from "./fixtures";

// Admin UI (T-17, AC-07, J10, BR-13). The E2E server's today is Fri 16 Oct 2026 (NOW_OVERRIDE).

async function axe(page: Page, state: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe (${state})`).toEqual([]);
}

async function signIn(page: Page, password: string = E2E_ADMIN.password) {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/); // no session: the proxy sends staff to sign in
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const SAT_8PM = Date.parse("2026-10-17T20:00:00+05:30");

test("AC-07 a booking made in chat appears in admin, by date and branch @cat:booking_success", async ({ page, observed }) => {
  observed.pii.push("Asha Rao", "98765 43210");
  await page.goto("/");
  await page.getByRole("button", { name: "Book a table" }).click();
  await page.getByRole("button", { name: "Hauz Khas", exact: true }).click();
  await page.getByRole("button", { name: "Tomorrow, Sat 17 Oct" }).click();
  await page.getByRole("button", { name: "4 guests", exact: true }).click();
  await page.getByRole("button", { name: "7:30 PM", exact: true }).last().click();
  const form = page.getByRole("form", { name: "Confirm your booking" });
  await form.getByLabel("Name").fill("Asha Rao");
  await form.getByLabel("Mobile number").fill("+91 98765 43210");
  await form.getByRole("button", { name: "Confirm" }).click();
  const ref = await page.locator("[data-confirmation-ref]").getAttribute("data-confirmation-ref");

  await signIn(page);
  await expect(page.getByRole("heading", { name: "Bookings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Friday, 16 October 2026" })).toBeVisible(); // opens on today
  await expect(page.getByText("No bookings for this day.")).toBeVisible();
  await axe(page, "admin empty");

  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page.getByRole("heading", { name: "Saturday, 17 October 2026" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Asha Rao" });
  await expect(row).toContainText("7:30 PM");
  await expect(row).toContainText("Hauz Khas");
  await expect(row).toContainText("Confirmed");
  await expect(row).toContainText(ref!);
  await expect(page.getByTestId("totals")).toHaveText("1 booking, 4 guests");
  await axe(page, "admin with bookings");

  await page.getByLabel("Branch").selectOption("gurugram");
  await expect(page.getByText("No bookings for this day at this branch.")).toBeVisible();
  await page.getByLabel("Branch").selectOption("all");
  await expect(row).toBeVisible();
});

test("J10 cancelling in admin frees the slot straight away @cat:booking_success", async ({ page, api, request, server, observed }) => {
  observed.pii.push("Kabir Mehta", "99887 76655");
  // Only the 8-top fits 7 guests, so this booking makes 8 PM unavailable for another party of 7.
  expect((await api.post("/api/reservations", { branch: "hauz-khas", startsAt: SAT_8PM, partySize: 7, name: "Kabir Mehta", phone: "99887 76655" }, { "idempotency-key": crypto.randomUUID() })).status).toBe(201);
  const eightOpen = async () => ((await (await request.get(`${server.origin}/api/availability?branch=hauz-khas&date=2026-10-17&party=7&time=20:00`)).json()).slots as { time: string }[]).some((s) => s.time === "20:00");
  expect(await eightOpen()).toBe(false);

  await signIn(page);
  await page.getByRole("button", { name: "Next day" }).click();
  const row = page.getByRole("row").filter({ hasText: "Kabir Mehta" });
  await row.getByRole("button", { name: "Cancel Kabir Mehta's booking at 8:00 PM" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this booking?" });
  await expect(dialog).toBeVisible();
  await axe(page, "cancel dialog");
  await dialog.getByRole("button", { name: "Keep booking" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText("Confirmed");

  await row.getByRole("button", { name: "Cancel Kabir Mehta's booking at 8:00 PM" }).click();
  await dialog.getByRole("button", { name: "Cancel booking" }).click();
  await expect(row).toContainText("Cancelled");
  await expect(page.getByTestId("totals")).toHaveText("0 bookings, 0 guests");
  expect(await eightOpen()).toBe(true);
  expect(observed.cancelResponses).toEqual([{ status: 200, ref: expect.stringMatching(/^NE-/) }]);
});

test("signing out revokes the session, including copies of the cookie", async ({ page, request, server }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Bookings" })).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => c.name === "ne_admin")!;
  expect((await request.get(`${server.origin}/api/admin/reservations`, { headers: { cookie: `ne_admin=${cookie.value}` } })).status()).toBe(200);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect((await request.get(`${server.origin}/api/admin/reservations`, { headers: { cookie: `ne_admin=${cookie.value}` } })).status()).toBe(401);
});

test.describe("on the low-limit server", () => {
  test.use({ baseURL: `http://127.0.0.1:${PORTS.lowLimit}` });

  test("sign-in is throttled after repeated attempts", async ({ page }) => {
    const error = page.locator("#login-error"); // Next.js's route announcer is also role=alert
    await signIn(page, "not-the-password");
    await expect(error).toHaveText("That password isn't right.");
    await axe(page, "login error");
    await page.getByLabel("Password").fill("still-not-it");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(error).toHaveText("That password isn't right.");
    await page.getByLabel("Password").fill(E2E_ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(error).toHaveText("Too many sign-in attempts. Please wait a minute.");
    await expect(page).toHaveURL(/\/admin\/login$/);
  });
});
