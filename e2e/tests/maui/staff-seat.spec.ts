import { test, expect } from "@playwright/test";
import { API_BASE, MAUI_ACCOUNTS, expectNoErrorPage, loginAs } from "./helpers";

/**
 * The staff seat (#880, LOCKED_DECISIONS §4A.9) — READ-ONLY.
 *
 * `quality-staff@` is its own role: it lands on the gaps assigned to it, works one case at a time, and
 * none of the lead's practice-wide levers (bulk actions, attributed lists, campaigns, the People
 * directory) is offered to it. The rule table and the worker's refusals are pinned by the backend's
 * `authorize.test.ts` and `staff-seat.worker.test.ts`; this walks the screens. The one write it sends is
 * a bulk assign of NO cases, which changes nothing even if the gate it checks ever regressed.
 */
test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  test.setTimeout(120_000);
});

const STAFF = MAUI_ACCOUNTS.qualityStaff.email;

test.describe("Maui staff seat", () => {
  test("lands on its own cases, with none of the lead's levers in its nav or on its screens", async ({ page, request }) => {
    await loginAs(page, STAFF);
    await expect(page).toHaveURL(/\/cases\?view=mine/);
    await expect(page.getByRole("heading", { name: "Assigned to you" })).toBeVisible({ timeout: 30_000 });
    await expectNoErrorPage(page);

    for (const lead of ["nav-lists", "nav-campaigns", "nav-people"]) await expect(page.getByTestId(lead)).toHaveCount(0);
    await expect(page.getByTestId("nav-cases")).toBeVisible();

    // A pasted link to a lead's screen says why, rather than failing on a refused request.
    await page.goto("/lists");
    await expect(page.getByText(/Attributed lists are your lead's/)).toBeVisible({ timeout: 20_000 });
    await page.goto("/campaigns");
    await expect(page.getByText(/Outreach campaigns are managed by Case Managers and Admins/)).toBeVisible({ timeout: 20_000 });

    // The work list, one patient at a time: no row selection, so no bulk bar. (The insurance filter's
    // checkboxes sit above the table.)
    await page.goto("/worklist?panel=all");
    await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("table").getByRole("checkbox")).toHaveCount(0);

    // The way to the practice one gap per row opens All cases, not the seat's own.
    await page.getByRole("link", { name: /View (the whole practice )?by gap/ }).click();
    await expect(page).toHaveURL(/\/cases/);
    await expect(page).not.toHaveURL(/view=mine/);
    await expect(page.getByRole("heading", { name: "Open and recent cases" })).toBeVisible({ timeout: 30_000 });

    // The server refuses the seat's own session too, not only the screen.
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem("ww_token") ?? "null") as string | null);
    expect(token, "the signed-in page holds a token").toBeTruthy();
    const bulk = await request.post(`${API_BASE}/api/cases/bulk-assign`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { assignee: STAFF, caseIds: [] },
    });
    expect(bulk.status(), "bulk assign is the lead's").toBe(403);
  });
});
