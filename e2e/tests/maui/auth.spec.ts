import { test, expect } from "@playwright/test";
import {
  MAUI_ACCOUNTS,
  MAUI_PASSWORD,
  API_BASE,
  loginAs,
  expectNoErrorPage,
} from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

const ACCOUNTS = [
  MAUI_ACCOUNTS.qualityLead,
  MAUI_ACCOUNTS.qualityStaff,
  MAUI_ACCOUNTS.clinician,
  MAUI_ACCOUNTS.admin,
];

test.describe("Maui authentication", () => {
  for (const account of ACCOUNTS) {
    test(`${account.email} logs in and lands on /programs`, async ({ page }) => {
      await loginAs(page, account.email);
      await expect(page).toHaveURL(/\/programs/);
      await expectNoErrorPage(page);
    });
  }

  test("bad password shows a visible error", async ({ page }) => {
    await page.goto("/login");
    await page.locator("#email").fill(MAUI_ACCOUNTS.qualityLead.email);
    await page.locator("#password").fill("wrong-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.locator("p[role='alert']")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("logout returns to /login", async ({ page }) => {
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);
    const logoutButton = page.getByRole("button", { name: /log ?out|sign out/i });
    await expect(logoutButton).toBeVisible({ timeout: 5_000 });
    await logoutButton.click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test("viewer gets 403 on POST /api/runs/manual", async ({ request }) => {
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: MAUI_ACCOUNTS.clinician.email, password: MAUI_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const { token } = (await login.json()) as { token: string };

    const res = await request.post(`${API_BASE}/api/runs/manual`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { scopeType: "ALL_PROGRAMS" },
    });
    expect(res.status()).toBe(403);
  });
});
