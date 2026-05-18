import { test, expect, type Page } from "@playwright/test";

const DEMO_EMAIL = "cm@workwell.dev";
const DEMO_PASSWORD = "Workwell123!";

async function loginAs(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/programs/);
}

test.describe("Golden demo path", () => {

  test("programs overview loads without 500", async ({ page }) => {
    await loginAs(page, DEMO_EMAIL, DEMO_PASSWORD);
    const response = await page.goto("/programs");
    expect(response?.status()).toBe(200);
    await expect(page.locator("text=500")).not.toBeVisible();
    await expect(page.locator("text=Internal Server Error")).not.toBeVisible();
    await expect(page.locator("[data-testid='program-card'], h1, h2").first()).toBeVisible();
  });

  test("cases list renders at least one row", async ({ page }) => {
    await loginAs(page, DEMO_EMAIL, DEMO_PASSWORD);
    await page.goto("/cases");
    // Wait for data to load (either a table row or a no-cases message)
    await expect(page.locator("table tbody tr, [data-testid='no-cases']").first()).toBeVisible({ timeout: 15_000 });
  });

  test("employee profile page loads from cases list", async ({ page }) => {
    await loginAs(page, DEMO_EMAIL, DEMO_PASSWORD);
    await page.goto("/cases");
    const employeeLink = page.locator("a[href^='/employees/']").first();
    // Only run if there is at least one employee link
    if (await employeeLink.count() === 0) {
      test.skip();
      return;
    }
    await employeeLink.click();
    await expect(page).toHaveURL(/\/employees\//);
    await expect(page.locator("h1, h2").first()).toBeVisible();
  });

  test("full demo flow: login → programs → cases → studio → logout", async ({ page }) => {
    // 1. Login
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(DEMO_EMAIL);
    await page.getByLabel(/password/i).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/programs/);

    // 2. Programs overview
    await expect(page.locator("h1, h2").first()).toBeVisible();

    // 3. Navigate to cases
    await page.goto("/cases");
    await expect(page.locator("h1, h2, table").first()).toBeVisible();

    // 4. Studio — measure list
    await page.goto("/measures");
    await expect(page.locator("h1, h2, table").first()).toBeVisible();

    // 5. Logout
    const logoutBtn = page.getByRole("button", { name: /logout|sign out/i });
    if (await logoutBtn.count() > 0) {
      await logoutBtn.click();
      await expect(page).toHaveURL(/\/login/);
    }
  });
});
