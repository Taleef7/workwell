import { test, expect, type Page } from "@playwright/test";

const DEMO_EMAIL = "cm@workwell.dev";
const DEMO_PASSWORD = "Workwell123!";

async function loginAs(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/programs/);
}

// Wait for the cases page to finish loading by waiting for an employee link
// (rendered only after the async /api/cases fetch resolves) or the empty state.
async function waitForCasesLoaded(page: Page) {
  await expect(
    page.locator("a[href^='/employees/'], [data-testid='no-cases'], .rounded-2xl.border:not(.border-dashed)").first()
  ).toBeVisible({ timeout: 20_000 });
}

test.describe("Golden demo path", () => {

  test("programs overview loads without 500", async ({ page }) => {
    await loginAs(page, DEMO_EMAIL, DEMO_PASSWORD);
    const response = await page.goto("/programs");
    expect(response?.status()).toBe(200);
    await expect(page.locator("text=500")).not.toBeVisible();
    await expect(page.locator("text=Internal Server Error")).not.toBeVisible();
    await expect(page.locator("h1, h2").first()).toBeVisible();
  });

  test("cases list renders at least one case after data loads", async ({ page }) => {
    await loginAs(page, DEMO_EMAIL, DEMO_PASSWORD);
    await page.goto("/cases");
    // Wait for async /api/cases to resolve — employee links only appear after cards render
    await waitForCasesLoaded(page);
    const caseCards = page.locator("a[href^='/employees/']");
    await expect(caseCards.first()).toBeVisible({ timeout: 5_000 });
  });

  test("employee profile page loads from cases list", async ({ page }) => {
    await loginAs(page, DEMO_EMAIL, DEMO_PASSWORD);
    await page.goto("/cases");
    // Wait for cases to fully load before checking for employee links
    await waitForCasesLoaded(page);

    const employeeLink = page.locator("a[href^='/employees/']").first();
    await expect(employeeLink).toBeVisible({ timeout: 5_000 });
    await employeeLink.click();
    await expect(page).toHaveURL(/\/employees\//);
    await expect(page.locator("h1, h2").first()).toBeVisible();
  });

  test("full demo flow: login → programs → cases → studio → logout", async ({ page }) => {
    // 1. Login
    await page.goto("/login");
    await page.locator("#email").fill(DEMO_EMAIL);
    await page.locator("#password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/programs/);

    // 2. Programs overview
    await expect(page.locator("h1, h2").first()).toBeVisible();

    // 3. Navigate to cases
    await page.goto("/cases");
    await waitForCasesLoaded(page);

    // 4. Studio — measure list
    await page.goto("/measures");
    await expect(page.locator("h1, h2, table").first()).toBeVisible();

    // 5. Logout — required step, not optional
    const logoutButton = page.getByRole("button", { name: /log ?out|sign out/i });
    await expect(logoutButton).toBeVisible({ timeout: 5_000 });
    await logoutButton.click();
    await expect(page).toHaveURL(/\/login/);
  });
});
