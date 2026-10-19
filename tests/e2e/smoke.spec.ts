import { expect, test } from "@playwright/test";

test("guest page renders the restaurant name", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Neem & Ember");
});
