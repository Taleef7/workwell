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

  test("columns are exactly the ACO's five measures with correct crosswalk labels", async ({ page }) => {
    // Updated for U1 (ADR-072): the Maui runnable set became the ACO's five official measures, and the
    // authored `hypertension` column went with it. This spec still asserted the old three — it is
    // manual-dispatch only, so nothing had run it since.
    await page.goto("/compliance");
    for (const label of [/MIPS 001 · CMS122/, /MIPS 112 · CMS125/, /MIPS 134 · CMS2/, /MIPS 113 · CMS130/, /MIPS 236 · CMS165/]) {
      await expect(page.getByRole("columnheader", { name: label })).toBeVisible({ timeout: 20_000 });
    }

    // No occupational measure columns, and no leftover authored one.
    const headers = await page.getByRole("columnheader").allTextContents();
    const headerText = headers.join(" ");
    for (const absent of ["HAZWOPER", "Audiogram", "TB Surveillance", "Hypertension"]) {
      expect(headerText, `${absent} must not appear on the pilot roster`).not.toContain(absent);
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

    // The site filter is the GLOBAL header filter (a custom combobox, rendered twice for the
    // responsive layouts), not a roster control. The roster footer reads "<total> patients".
    const total = page.getByText(/^\d+ patients?$/).filter({ visible: true }).first();
    await expect(total).toHaveText(/^48 patients$/, { timeout: 20_000 });

    const siteFilter = page.getByRole("combobox", { name: "Filter by site" }).filter({ visible: true }).first();
    await siteFilter.click();
    await page.getByRole("option", { name: "Kihei Clinic" }).first().click();

    await expect(total).not.toHaveText(/^48 patients$/, { timeout: 20_000 });
    const totalText = (await total.textContent()) ?? "";
    const filteredTotal = Number(totalText.match(/^(\d+)/)?.[1]);
    expect(filteredTotal).toBeGreaterThan(0);
    expect(filteredTotal).toBeLessThan(48);
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

test.describe("Maui roster panel filters", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);
  });

  test("selecting a PCP narrows the roster to that panel and carries providerId in the URL", async ({ page }) => {
    await page.goto("/compliance");
    await expect(page.getByRole("heading", { name: /Individual Compliance/i })).toBeVisible({ timeout: 20_000 });

    const before = await page.getByRole("row").count();
    expect(before, "the unfiltered roster must have rows for this to mean anything").toBeGreaterThan(1);

    const pcpSelect = page.getByLabel(/^PCP$/);
    await expect(pcpSelect).toBeVisible({ timeout: 10_000 });
    // The second option: the first is "All panels". Selected by VALUE so the assertion below is about
    // the id the backend filters on, not a display name.
    const providerId = await pcpSelect.locator("option").nth(1).getAttribute("value");
    expect(providerId).toBeTruthy();
    await pcpSelect.selectOption(providerId!);

    await expect(page).toHaveURL(new RegExp(`providerId=${providerId}`), { timeout: 20_000 });
    // The chip row names the panel, and the roster is strictly smaller than the whole practice.
    await expect(page.getByText(/^Filtered to$/)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => page.getByRole("row").count(), { timeout: 20_000 }).toBeLessThan(before);

    await expectNoErrorPage(page);
  });

  test("a deep link with all three filters renders filtered, and Clear restores the whole roster", async ({ page }) => {
    await page.goto("/compliance?ageBand=65%2B&sex=F");
    await expect(page.getByText(/^Filtered to$/)).toBeVisible({ timeout: 20_000 });
    const filtered = await page.getByRole("row").count();

    await page.getByRole("button", { name: /^Clear$/ }).first().click();
    await expect(page.getByText(/^Filtered to$/)).toBeHidden({ timeout: 20_000 });
    await expect.poll(async () => page.getByRole("row").count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(filtered);

    await expectNoErrorPage(page);
  });
});
