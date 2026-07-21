import { test, expect, type Page } from "@playwright/test";
import { ADMIN_EMAIL, loginAs } from "./helpers";

async function gotoRoster(page: Page) {
  await loginAs(page, ADMIN_EMAIL);
  await page.goto("/compliance");
  await expect(page.getByRole("heading", { name: /Individual Compliance Status/i })).toBeVisible();
  // Wait for the first roster fetch to land (rows or explicit empty state).
  await expect(
    page.locator("table tbody tr").first()
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("Compliance roster filters", () => {
  test("panel switcher changes the measure columns", async ({ page }) => {
    await gotoRoster(page);

    // Default panel: Immunizations — MMR column present.
    await expect(page.locator("thead th", { hasText: /MMR/i }).first()).toBeVisible({ timeout: 20_000 });

    // OSHA Surveillance panel — Audiogram column appears, MMR disappears.
    await page.getByLabel("Panel").selectOption({ label: "OSHA Surveillance" });
    await expect(page.locator("thead th", { hasText: /Audiogram/i }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("thead th", { hasText: /MMR/i })).toHaveCount(0);

    // Wellness & eCQM panel — Hypertension column appears.
    await page.getByLabel("Panel").selectOption({ label: "Wellness & eCQM" });
    await expect(page.locator("thead th", { hasText: /Hypertension/i }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("thead th", { hasText: /Audiogram/i })).toHaveCount(0);
  });

  test("status filter requeries the roster", async ({ page }) => {
    await gotoRoster(page);
    const responsePromise = page.waitForResponse(
      (r) => r.url().includes("/api/compliance/roster") && r.url().includes("status=OVERDUE"),
      { timeout: 30_000 }
    );
    await page.getByLabel("Status").selectOption({ label: "Overdue" });
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    // Grid settles into either filtered rows or the explicit empty state — never an error.
    await expect(
      page.locator("tbody tr").first().or(page.getByText("No employees match these filters."))
    ).toBeVisible({ timeout: 30_000 });
    // Roster errors render as p[role=alert]; the Next route announcer is excluded.
    await expect(page.locator("p[role='alert']")).toHaveCount(0);
  });

  test("system (tenant) select scopes rows to one WebChart system", async ({ page }) => {
    await gotoRoster(page);
    const responsePromise = page.waitForResponse(
      (r) => r.url().includes("/api/compliance/roster") && r.url().includes("tenant=ihn"),
      { timeout: 30_000 }
    );
    await page.getByLabel("System").selectOption({ label: "Indus Hospital Network" });
    expect((await responsePromise).ok()).toBe(true);
    // Every visible row's subtext names the selected system.
    const firstRow = page.locator("tbody tr").first();
    await expect(firstRow).toContainText(/Indus Hospital Network/i, { timeout: 30_000 });
    await expect(page.locator("tbody tr", { hasText: /Total Worker Health/i })).toHaveCount(0);
  });

  test("search box filters rows and empty search shows the empty state", async ({ page }) => {
    await gotoRoster(page);
    const initialRows = await page.locator("tbody tr").count();
    expect(initialRows).toBeGreaterThan(0);

    // The header also has a global "Search employees" box — target the roster filter by placeholder.
    const searchBox = page.getByPlaceholder("Name or ID");
    await searchBox.fill("zzz-no-such-employee");
    // Rendered in both the desktop table and the (hidden) mobile card layout — assert the table cell.
    await expect(
      page.getByRole("cell", { name: "No employees match these filters." })
    ).toBeVisible({ timeout: 30_000 });

    await searchBox.fill("");
    await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
    const restoredRows = await page.locator("tbody tr").count();
    expect(restoredRows).toBeGreaterThan(0);
  });
});
