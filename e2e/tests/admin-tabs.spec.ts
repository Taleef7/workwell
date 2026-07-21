import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, loginAs, expectNoErrorPage } from "./helpers";

const ADMIN_TABS = ["Operations", "Governance", "Outreach", "Groups", "Audit"];

test.describe("Admin console tabs", () => {
  test("all admin tabs render without error", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: /Operations, waivers, and audit access/i })
    ).toBeVisible({ timeout: 20_000 });

    for (const tabName of ADMIN_TABS) {
      const tab = page.getByRole("tab", { name: tabName });
      await expect(tab).toBeVisible({ timeout: 10_000 });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      // The active tabpanel must render content (lazy-loaded per tab) without an error page.
      await expect(page.getByRole("tabpanel")).toBeVisible({ timeout: 20_000 });
      await expectNoErrorPage(page);
    }
  });
});
