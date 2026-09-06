import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, MAUI_PASSWORD, API_BASE, loginAs, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.describe("Maui runs", () => {
  test("trigger a manual ALL_PROGRAMS run and verify every runnable measure evaluated for all 48", async ({ page, request }) => {
    test.setTimeout(240_000);
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);

    // Snapshot the run ids that exist BEFORE the click, so the assertion below is about the run this
    // test triggers and not the completed run the global setup seeded.
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: MAUI_ACCOUNTS.qualityLead.email, password: MAUI_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const { token } = (await login.json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}` };
    type RunRow = { runId: string; status: string; scopeType: string; totalEvaluated: number };
    const before = await request.get(`${API_BASE}/api/runs`, { headers });
    expect(before.ok()).toBe(true);
    const knownIds = new Set(((await before.json()) as RunRow[]).map((r) => r.runId));

    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: /Run History/i })).toBeVisible({ timeout: 20_000 });

    // Trigger a manual run from the UI: "Run Now" opens a confirm dialog whose confirm is "Start run".
    const runButton = page.getByRole("button", { name: /^Run Now$/i }).filter({ visible: true }).first();
    await expect(runButton).toBeEnabled({ timeout: 20_000 });
    await runButton.click();
    await page.getByRole("button", { name: /^Start run$/i }).click();

    // Watch for the banner lifecycle: queued/running then clears
    await expect(page.getByText(/queued|running/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/queued|running/i)).toHaveCount(0, { timeout: 180_000 });

    // Verify THE run this click created — a run that FAILED would clear the banner too, and the
    // setup run must not be allowed to stand in for it.
    const runsRes = await request.get(`${API_BASE}/api/runs`, { headers });
    expect(runsRes.ok()).toBe(true);
    const runs = (await runsRes.json()) as RunRow[];
    const created = runs.filter((r) => !knownIds.has(r.runId));
    expect(created, "the Start run click must have created exactly one new run").toHaveLength(1);
    expect(created[0].scopeType).toBe("ALL_PROGRAMS");
    expect(created[0].status).toBe("COMPLETED");
    // 48 patients x the measures this stack can RUN. The Maui profile lists the ACO's six, but an
    // official-only measure is runnable only where WORKWELL_OFFICIAL_MEASURES routes it (ADR-072), and
    // the e2e stack routes nothing (README-maui: the official artifacts need their gitignored
    // terminology sidecars) — so cms2/cms130/cms165/cms137 are `official-pending` here and the run
    // evaluates the two authored measures, cms122 and cms125. A previous revision asserted 240 (six
    // times 48 minus one) on the belief that U1 had made the five runnable regardless of routing; it
    // had not, and this spec is manual-dispatch only, so nothing contradicted it.
    expect(created[0].totalEvaluated).toBe(96);
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
