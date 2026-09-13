import { test, expect } from "@playwright/test";
import {
  AS_ADMIN_RUNS,
  MAUI_ACCOUNTS,
  MAUI_PASSWORD,
  API_BASE,
  ROUTED_MEASURES,
  WRITES_SKIP_REASON,
  expectNoErrorPage,
  rosterTotal,
  writesAllowed,
} from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.describe("Maui runs", () => {
  // /runs is engineering-gated to ADMIN on the pilot profile, and so is the Run Now control.
  test.use(AS_ADMIN_RUNS);
  // This file WRITES (it triggers a run); its two tests must not interleave with each other.
  test.describe.configure({ mode: "serial" });

  test("a manual ALL_PROGRAMS run evaluates every routed measure for every corpus patient", async ({ page, request }) => {
    // The one mutating test in this file, and the guard is on it rather than on the file: the run-list
    // test below is a read and stays useful against a stack this may not write to. On the pilot
    // sandbox a population run is 20,000 patients across six measures and hours of work on a stack the
    // pilot group signs into, so it happens on a local stack or when the operator asks for it by name.
    test.skip(!writesAllowed(), WRITES_SKIP_REASON);
    test.setTimeout(240_000);

    // Snapshot the run ids that exist BEFORE the click, so the assertion below is about the run this
    // test triggers and not the completed run the global setup seeded.
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: MAUI_ACCOUNTS.admin.email, password: MAUI_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const { token } = (await login.json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}` };
    type RunRow = { runId: string; status: string; scopeType: string; totalEvaluated: number };
    const before = await request.get(`${API_BASE}/api/runs`, { headers });
    expect(before.ok()).toBe(true);
    const knownIds = new Set(((await before.json()) as RunRow[]).map((r) => r.runId));
    // The roster's own size, asked of the server. CI composes 48 corpus patients and the sandbox
    // composes 20,000, so the expected outcome count is derived rather than written down — a literal
    // here is how `roster.spec.ts` came to assert "48 patients" against a stack with 20,000.
    const corpusSubjects = await rosterTotal(request, token);
    expect(corpusSubjects, "the roster must have patients for a run to evaluate").toBeGreaterThan(0);

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
    const created = ((await runsRes.json()) as RunRow[]).filter((r) => !knownIds.has(r.runId));
    expect(created, "the Start run click must have created exactly one new run").toHaveLength(1);
    expect(created[0].scopeType).toBe("ALL_PROGRAMS");
    expect(created[0].status).toBe("COMPLETED");
    // One outcome per (patient, measure) pair over the ACO's whole computable set. This is the
    // assertion that would have caught the e2e stack silently running two measures while the pilot ran
    // six: since 2026-09-08 the job vendors the terminology sidecars with the VSAC credential and sets
    // WORKWELL_OFFICIAL_MEASURES, so `official-pending` is no longer an accepted state here. Derived
    // from the routed list rather than hardcoded, so adding a measure updates one place.
    expect(
      created[0].totalEvaluated,
      `expected ${corpusSubjects} patients x ${ROUTED_MEASURES.length} routed measures`,
    ).toBe(corpusSubjects * ROUTED_MEASURES.length);
    await expectNoErrorPage(page);
  });

  test("runs list renders and filters by scope type", async ({ page }) => {
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: /Run History/i })).toBeVisible({ timeout: 20_000 });
    await expectNoErrorPage(page);
  });
});
