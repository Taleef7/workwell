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

// This spec is ABOUT signing in, so it drives the form and takes no shared storage state.
test.describe("Maui authentication", () => {
  test("every Maui account logs in and lands on /programs", async ({ page }) => {
    for (const account of ACCOUNTS) {
      await loginAs(page, account.email);
      await expect(page, `${account.email} should land on /programs`).toHaveURL(/\/programs/);
      await expectNoErrorPage(page);
      await page.getByRole("button", { name: /log ?out|sign out/i }).click();
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    }
  });

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

    // The scope names a subject that does not exist, deliberately. This test asserts a REFUSAL, so
    // the request it sends is one that must not mutate anything even if the refusal stops happening:
    // the day the authorization table regresses — which is the day this test earns its place — a
    // request for ALL_PROGRAMS would start a population run over 20,000 patients before the assertion
    // below could fail. A spec in the read-only project has to be harmless when the thing it tests is
    // broken, not only when it works.
    const res = await request.post(`${API_BASE}/api/runs/manual`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { scopeType: "EMPLOYEE", employeeId: "no-such-subject-e2e" },
    });
    expect(res.status()).toBe(403);
  });
});
