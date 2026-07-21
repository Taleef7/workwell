import { expect, type Page } from "@playwright/test";

export const ADMIN_EMAIL = "admin@workwell.dev";
export const CM_EMAIL = "cm@workwell.dev";
export const DEMO_PASSWORD = "Workwell123!";

/** Backend origin for direct API probes (data discovery, not UI assertions). */
export const API_BASE = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:8080";

export async function loginAs(page: Page, email: string, password: string = DEMO_PASSWORD) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/programs/, { timeout: 15_000 });
}

/** Assert the current page shows no server/application error surface. */
export async function expectNoErrorPage(page: Page) {
  await expect(page.locator("text=Internal Server Error")).not.toBeVisible();
  await expect(page.locator("text=Application error")).not.toBeVisible();
  // Next.js error pages render the status code as a heading.
  await expect(page.locator("h1", { hasText: /^500$/ })).not.toBeVisible();
  await expect(page.locator("h1", { hasText: /^404$/ })).not.toBeVisible();
}
