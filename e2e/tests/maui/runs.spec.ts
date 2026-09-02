import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, MAUI_PASSWORD, API_BASE, loginAs, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.describe("Maui runs", () => {
  test("trigger a manual ALL_PROGRAMS run and verify 144 evaluated", async ({ page, request }) => {
    test.setTimeout(240_000);
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: /Run History/i })).toBeVisible({ timeout: 20_000 });

    // Trigger a manual run from the UI
    const runButton = page.getByRole("button", { name: /^Run$/i }).first();
    await expect(runButton).toBeEnabled({ timeout: 20_000 });
    await runButton.click();

    // Watch for the banner lifecycle: queued/running then clears
    await expect(page.getByText(/queued|running/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/queued|running/i)).toHaveCount(0, { timeout: 180_000 });

    // Verify the completed run via API
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: MAUI_ACCOUNTS.qualityLead.email, password: MAUI_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const { token } = (await login.json()) as { token: string };

    const runsRes = await request.get(`${API_BASE}/api/runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(runsRes.ok()).toBe(true);
    const runs = (await runsRes.json()) as Array<{ status: string; scopeType: string; totalEvaluated: number }>;
    const completed = runs.find((r) => r.status === "COMPLETED" && r.scopeType === "ALL_PROGRAMS");
    expect(completed).toBeDefined();
    expect(completed!.totalEvaluated).toBe(144);
    await expectNoErrorPage(page);
  });

  test("runs list filter by scopeType works", async ({ page }) => {
    test.setTimeout(60_000);
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: /Run History/i })).toBeVisible({ timeout: 20_000 });
    await expectNoErrorPage(page);
  });
});
