import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, loginAs, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.describe("Maui measures catalog", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);
  });

  test("Identity column shows MIPS 001 · CMS122 and MIPS 112 · CMS125", async ({ page }) => {
    await page.goto("/measures");
    await expect(page.getByText("MIPS 001 · CMS122").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("MIPS 112 · CMS125").first()).toBeVisible({ timeout: 20_000 });
    await expectNoErrorPage(page);
  });

  test("measure detail for cms125 opens without error", async ({ page }) => {
    await page.goto("/programs/cms125");
    await expectNoErrorPage(page);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
  });
});
