import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, loginAs, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.describe("Maui compliance roster", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);
  });

  test("roster shows 48 total rows across pages", async ({ page }) => {
    await page.goto("/compliance");
    await expect(page.getByRole("heading", { name: /Individual Compliance/i })).toBeVisible({ timeout: 20_000 });

    // The total count is rendered near the pagination controls.
    const totalText = page.getByText(/of\s*48|48\s*(patients|rows|total)/i).first();
    await expect(totalText).toBeVisible({ timeout: 20_000 });
  });

  test("columns are exactly the three Maui measures with correct crosswalk labels", async ({ page }) => {
    await page.goto("/compliance");
    await expect(page.getByRole("columnheader", { name: /MIPS 001 · CMS122/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("columnheader", { name: /MIPS 112 · CMS125/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("columnheader", { name: /Hypertension/ })).toBeVisible({ timeout: 20_000 });

    // No occupational measure columns
    const headers = await page.getByRole("columnheader").allTextContents();
    const headerText = headers.join(" ");
    expect(headerText).not.toContain("HAZWOPER");
    expect(headerText).not.toContain("Audiogram");
    expect(headerText).not.toContain("TB Surveillance");

    // Hypertension column carries no MIPS label
    for (const header of headers) {
      if (header.includes("Hypertension")) {
        expect(header, "hypertension column must not carry a MIPS label").not.toContain("MIPS");
      }
    }
  });

  test("status filter narrows rows", async ({ page }) => {
    await page.goto("/compliance");
    await expect(page.getByRole("heading", { name: /Individual Compliance/i })).toBeVisible({ timeout: 20_000 });

    const statusSelect = page.getByLabel("Status");
    await expect(statusSelect).toBeVisible({ timeout: 10_000 });
    await statusSelect.selectOption({ label: "Overdue" });

    // Wait for the filtered state
    const rows = page.locator("tbody tr");
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThan(48);
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThan(48);
  });

  test("site filter narrows to Kihei Clinic", async ({ page }) => {
    await page.goto("/compliance");
    await expect(page.getByRole("heading", { name: /Individual Compliance/i })).toBeVisible({ timeout: 20_000 });

    const panelSelect = page.getByLabel("Panel");
    await expect(panelSelect).toBeVisible({ timeout: 10_000 });
    await panelSelect.selectOption({ label: "Kihei Clinic" });

    const rows = page.locator("tbody tr");
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThan(48);
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThan(48);
  });

  test("search by patient name narrows rows", async ({ page }) => {
    await page.goto("/compliance");
    await expect(page.getByRole("heading", { name: /Individual Compliance/i })).toBeVisible({ timeout: 20_000 });

    const searchInput = page.getByPlaceholder("Name or ID");
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill("Ari Wren");

    const rows = page.locator("tbody tr");
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThanOrEqual(2);
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    expect(await rows.count()).toBeLessThanOrEqual(2);
  });

  test("clicking a patient name opens profile listing their measures", async ({ page }) => {
    await page.goto("/compliance");
    await expect(page.getByRole("heading", { name: /Individual Compliance/i })).toBeVisible({ timeout: 20_000 });

    const patientLink = page.locator("a[href^='/employees/']").filter({ visible: true }).first();
    await expect(patientLink).toBeVisible({ timeout: 20_000 });
    await patientLink.click();
    await expect(page).toHaveURL(/\/employees\//);
    await expectNoErrorPage(page);

    // The profile should reference the Maui measures the patient is due for.
    const body = await page.locator("body").innerText();
    const hasMeasureMention = /CMS122|CMS125|Hypertension|Diabetes|Breast/i.test(body);
    expect(hasMeasureMention, "patient profile should reference at least one Maui measure").toBe(true);
  });
});
