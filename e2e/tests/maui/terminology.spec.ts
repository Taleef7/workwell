import { test, expect, type Page } from "@playwright/test";
import { AS_ADMIN_TERMS, AS_QUALITY_LEAD_TERMS, expectNoErrorPage, expectNoEmployeeWording } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

/** The pages the quality lead actually works in. `/runs` and `/measures` are admin-gated — below. */
const LEAD_PAGES = ["/programs", "/cases", "/compliance", "/people"];
/** Engineering surfaces: as the quality lead these render AccessDenied, so the check would be vacuous. */
const ADMIN_PAGES = ["/runs", "/measures"];

async function expectPatientWording(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("heading").first(), `${path} should render`).toBeVisible({ timeout: 20_000 });
  await expectNoEmployeeWording(page);
  await expectNoErrorPage(page);
  await expect(page.getByRole("textbox", { name: /search patients/i })).toHaveAttribute(
    "placeholder",
    "Search patients…",
  );
}

test.describe("Maui terminology — the quality lead's pages", () => {
  test.use(AS_QUALITY_LEAD_TERMS);

  // One test walking the pages, not one test per page: each `test` costs a fresh browser context, and
  // the assertion is the same three lines every time.
  test("no employee wording, and the global search is about patients", async ({ page }) => {
    for (const path of LEAD_PAGES) await expectPatientWording(page, path);
  });

  test("case detail and patient profile carry no employee wording", async ({ page }) => {
    await page.goto("/cases");
    const caseLink = page.locator("a[href^='/cases/']").filter({ visible: true }).first();
    await expect(caseLink).toBeVisible({ timeout: 20_000 });
    await caseLink.click();
    await expect(page).toHaveURL(/\/cases\//);
    await expectNoEmployeeWording(page);
    await expectNoErrorPage(page);

    await page.goto("/compliance");
    const patientLink = page.locator("a[href^='/employees/']").filter({ visible: true }).first();
    await expect(patientLink).toBeVisible({ timeout: 20_000 });
    await patientLink.click();
    await expect(page).toHaveURL(/\/employees\//);
    await expectNoEmployeeWording(page);
    await expectNoErrorPage(page);
  });
});

test.describe("Maui terminology — the engineering surfaces", () => {
  test.use(AS_ADMIN_TERMS);

  test("no employee wording on the admin-only pages either", async ({ page }) => {
    for (const path of ADMIN_PAGES) await expectPatientWording(page, path);
  });
});
