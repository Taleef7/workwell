import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, CM_EMAIL, DEMO_PASSWORD, loginAs } from "./helpers";

test.describe("Authentication", () => {
  test("admin can log in and lands on /programs", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await expect(page.locator("h1, h2").first()).toBeVisible();
  });

  test("case manager (non-admin) can log in and lands on /programs", async ({ page }) => {
    await loginAs(page, CM_EMAIL);
    await expect(page.locator("h1, h2").first()).toBeVisible();
  });

  test("bad password is rejected with a visible error and no redirect", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(ADMIN_EMAIL);
    await page.locator("#password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    // The Next.js route announcer also has role=alert — target the login error paragraph.
    await expect(page.locator("p[role='alert']")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("empty credentials show a validation error", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.locator("p[role='alert']")).toContainText(/email and password/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test("logout returns to /login", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL, DEMO_PASSWORD);
    const logoutButton = page.getByRole("button", { name: /log ?out|sign out/i });
    await expect(logoutButton).toBeVisible({ timeout: 5_000 });
    await logoutButton.click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
