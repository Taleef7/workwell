import { test, expect } from "@playwright/test";
import { API_BASE, MAUI_PASSWORD } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.describe("Maui readiness", () => {
  test("programs page lists only the three Maui measures", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill("quality-lead@maui.workwell.dev");
    await page.locator("#password").fill(MAUI_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/programs/, { timeout: 15_000 });
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("HAZWOPER")).not.toBeVisible();
    await expect(page.getByText("Audiogram")).not.toBeVisible();
    await expect(page.getByText("TB Surveillance")).not.toBeVisible();
  });

  test("measures page lists no occupational measures", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill("quality-lead@maui.workwell.dev");
    await page.locator("#password").fill(MAUI_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/programs/, { timeout: 15_000 });
    await page.goto("/measures");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("HAZWOPER")).not.toBeVisible();
    await expect(page.getByText("Audiogram")).not.toBeVisible();
  });

  test("login page has no OSHA text and no sandbox links", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("OSHA")).not.toBeVisible();
    await expect(page.getByText("Open sandbox")).not.toBeVisible();
    await expect(page.getByText("Skip login")).not.toBeVisible();
  });

  test("root page has no sandbox text", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Open sandbox")).not.toBeVisible();
    await expect(page.getByText("Public sandbox")).not.toBeVisible();
  });

  test("sandbox route redirects to login", async ({ page }) => {
    await page.goto("/sandbox");
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test("TWH viewer account cannot authenticate on Maui stack", async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: "viewer@workwell.dev", password: MAUI_PASSWORD },
    });
    expect(res.status()).toBe(401);
  });
});
