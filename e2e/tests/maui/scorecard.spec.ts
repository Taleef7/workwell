import { test, expect } from "@playwright/test";
import { API_BASE, AS_QUALITY_LEAD_ROSTER, expectNoErrorPage, getAuthToken } from "./helpers";

/**
 * The provider × measure scorecard (#852) — READ-ONLY.
 *
 * The rates themselves are pinned by the backend's route tests (each cell equals the attributed-list
 * report's rate and its open gaps equal the work list's count). What only a live stack shows is that the
 * page renders on the pilot deployment for a case-managing seat, and that the route is not left to the
 * AUTHENTICATED catch-all, which would hand every provider's figures to the read-only sandbox seat.
 */
test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.use(AS_QUALITY_LEAD_ROSTER);

test.describe("Maui quality scorecard", () => {
  test("the page renders for a case-managing seat, with the estimate note and a print button", async ({ page }) => {
    await page.goto("/scorecard");
    await expect(page.getByRole("heading", { name: /Quality scorecard/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("scorecard-note")).toContainText(/counts under their PCP on file/i);
    await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
    await expectNoErrorPage(page);
  });

  test("the route answers the year it was asked, and refuses a malformed one", async ({ request }) => {
    const token = await getAuthToken(request);
    const headers = { authorization: `Bearer ${token}` };
    const year = new Date().getUTCFullYear();
    const ok = await request.get(`${API_BASE}/api/scorecard?measurementYear=${year}`, { headers });
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body.measurementYear).toBe(year);
    expect(Array.isArray(body.measures)).toBe(true);
    const bad = await request.get(`${API_BASE}/api/scorecard?measurementYear=27`, { headers });
    expect(bad.status()).toBe(400);
  });

  test("an anonymous caller is refused", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/scorecard`);
    expect(res.status()).toBe(401);
  });
});
