import { test, expect, type Page } from "@playwright/test";
import { ADMIN_EMAIL, DEMO_PASSWORD, API_BASE, apiReachable, loginAs } from "./helpers";

async function gotoRuns(page: Page) {
  await loginAs(page, ADMIN_EMAIL);
  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: /Run History/i })).toBeVisible({ timeout: 20_000 });
}

/** Open a @mieweb/ui Select (button[role=combobox]) and pick an option by label. */
async function pickOption(page: Page, comboboxName: string, optionLabel: string) {
  const combo = page.getByRole("combobox", { name: comboboxName }).filter({ visible: true }).first();
  await combo.click();
  await page.getByRole("option", { name: optionLabel, exact: true }).filter({ visible: true }).first().click();
}

test.describe("Runs page", () => {
  test("status filter narrows the run list to Completed runs", async ({ page }) => {
    await gotoRuns(page);
    const responsePromise = page.waitForResponse(
      (r) => r.url().includes("/api/runs") && r.url().includes("status=COMPLETED"),
      { timeout: 30_000 }
    );
    await pickOption(page, "Status", "Completed");
    expect((await responsePromise).ok()).toBe(true);

    // Every visible run row's status badge reads Completed.
    const rows = page.locator("tbody tr", { has: page.getByRole("button", { name: /View run details/ }) });
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText("Completed");
    }
  });

  test("trigger filter round-trips without error", async ({ page }) => {
    await gotoRuns(page);
    const responsePromise = page.waitForResponse(
      (r) => r.url().includes("/api/runs") && r.url().includes("triggerType=MANUAL"),
      { timeout: 30_000 }
    );
    await pickOption(page, "Trigger type", "Manual");
    expect((await responsePromise).ok()).toBe(true);
    // Runs-page errors render as p[role=alert]; the Next route announcer is excluded.
    await expect(page.locator("p[role='alert']")).toHaveCount(0);
  });

  test("selecting a run opens its detail panel", async ({ page }) => {
    await gotoRuns(page);
    const firstRunButton = page.getByRole("button", { name: /View run details/ }).first();
    await expect(firstRunButton).toBeVisible({ timeout: 30_000 });
    await firstRunButton.click();
    await expect(page.getByText("Outcome Counts")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Pass Rate:/)).toBeVisible();
  });

  test("completed single-measure run exposes MeasureReport + QRDA exports", async ({ page, request }) => {
    test.skip(!(await apiReachable(request)), `backend API not reachable at ${API_BASE}`);
    // Discover a completed MEASURE-scope run via the API; skip when none exists yet
    // (population runs are owned by another agent on this stack — we never trigger one).
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: ADMIN_EMAIL, password: DEMO_PASSWORD },
    });
    const { token } = (await login.json()) as { token: string };
    const runsRes = await request.get(`${API_BASE}/api/runs?limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = (await runsRes.json()) as
      | Array<{ runId: string; scopeType: string; status: string; measureName: string }>
      | { runs: Array<{ runId: string; scopeType: string; status: string; measureName: string }> };
    const runs = Array.isArray(payload) ? payload : payload.runs ?? [];
    const measureRun = runs.find((r) => r.scopeType === "MEASURE" && r.status === "COMPLETED");
    test.skip(!measureRun, "no COMPLETED MEASURE-scope run exists on the local stack yet");

    // Deep-link the exact run via ?runId= (the page supports it) rather than a name-based button
    // lookup — accumulated run history can push this run past the ~20 rows rendered initially, and
    // the button would then never appear.
    await loginAs(page, ADMIN_EMAIL);
    await page.goto(`/runs?runId=${measureRun!.runId}`);
    await expect(page.getByRole("heading", { name: /Run History/i })).toBeVisible({ timeout: 20_000 });

    const mrButton = page.getByRole("button", { name: "MeasureReport (FHIR)" });
    const qrdaButton = page.getByRole("button", { name: "QRDA III (XML)" });
    await expect(mrButton).toBeVisible({ timeout: 20_000 });
    await expect(qrdaButton).toBeVisible();

    // Clicking triggers a blob download fetch — assert the API responded 200, not the file save.
    const mrResponse = page.waitForResponse(
      (r) => r.url().includes("/measure-report"),
      { timeout: 30_000 }
    );
    await mrButton.click();
    expect((await mrResponse).status()).toBe(200);

    const qrdaResponse = page.waitForResponse(
      (r) => r.url().includes("/qrda"),
      { timeout: 30_000 }
    );
    await qrdaButton.click();
    expect((await qrdaResponse).status()).toBe(200);
  });
});
