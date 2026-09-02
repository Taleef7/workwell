import { test, expect, type Page } from "@playwright/test";
import { MAUI_ACCOUNTS, loginAs, expectNoErrorPage, expectNoEmployeeWording } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

const PAGES = ["/programs", "/cases", "/compliance", "/people", "/runs", "/measures"];

async function openCaseDetail(page: Page) {
  await page.goto("/cases");
  const caseLink = page.locator("a[href^='/cases/']").filter({ visible: true }).first();
  await expect(caseLink).toBeVisible({ timeout: 20_000 });
  await caseLink.click();
  await expect(page).toHaveURL(/\/cases\//);
}

async function openPatientProfile(page: Page) {
  await page.goto("/compliance");
  const patientLink = page.locator("a[href^='/employees/']").filter({ visible: true }).first();
  await expect(patientLink).toBeVisible({ timeout: 20_000 });
  await patientLink.click();
  await expect(page).toHaveURL(/\/employees\//);
}

test.describe("Maui terminology (patient, not employee)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);
  });

  for (const path of PAGES) {
    test(`${path} has no employee wording and shows patient search`, async ({ page }) => {
      // DEFECT (found by this suite, 2026-09-02): the roster's Segment filter lists the seeded TWH
      // cohorts ("All Employees", "OSHA Safety-Sensitive", "Clinical Staff") on the Maui profile —
      // backend-ts/src/segment/segment-seed.ts is not profile-aware. Fixed on fix/maui-segment-seed;
      // this marker comes off when that lands.
      test.fail(path === "/compliance", "segment seed names leak employee wording on Maui (fix/maui-segment-seed)");
      await page.goto(path);
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
      await expectNoEmployeeWording(page);
      await expectNoErrorPage(page);
      const search = page.getByRole("textbox", { name: /search patients/i });
      await expect(search).toHaveAttribute("placeholder", "Search patients…");
    });
  }

  test("case detail page has no employee wording", async ({ page }) => {
    await openCaseDetail(page);
    await expectNoEmployeeWording(page);
    await expectNoErrorPage(page);
  });

  test("patient profile page has no employee wording", async ({ page }) => {
    await openPatientProfile(page);
    await expectNoEmployeeWording(page);
    await expectNoErrorPage(page);
  });

  test("global search placeholder reads 'Search patients…'", async ({ page }) => {
    await page.goto("/programs");
    const search = page.getByRole("textbox", { name: /search patients/i });
    await expect(search).toBeVisible({ timeout: 10_000 });
    await expect(search).toHaveAttribute("placeholder", "Search patients…");
  });
});
