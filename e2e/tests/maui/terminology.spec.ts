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

  // #671: opening a patient ran a simulation nobody asked for, and the posture named four measures by
  // their raw ids. The simulation is now a button, and every posture chip carries a measure name.
  test("the patient page runs no simulation on open, and names every measure", async ({ page }) => {
    const simulateCalls: string[] = [];
    page.on("request", (req) => {
      if (/\/simulate\b/.test(req.url())) simulateCalls.push(req.url());
    });
    await page.goto("/compliance");
    const patientLink = page.locator("a[href^='/employees/']").filter({ visible: true }).first();
    await expect(patientLink).toBeVisible({ timeout: 20_000 });
    await patientLink.click();
    await expect(page).toHaveURL(/\/employees\//);

    const posture = page.getByText("Compliance Posture", { exact: true }).locator("..");
    await expect(posture.getByRole("link").first()).toBeVisible({ timeout: 20_000 });
    const postureText = await posture.innerText();
    expect(postureText, "a posture chip names its measure, not a raw id").not.toMatch(/\bcms\d+\b/);
    expect(postureText, "only the ACO's measures").not.toMatch(/Hypertension BP Screening/);
    await expect(page.getByRole("button", { name: /run simulation/i })).toBeVisible();
    // The old component fetched 300 ms after mount; give it well past that.
    await page.waitForTimeout(1_500);
    expect(simulateCalls, "opening the page must not run a simulation").toEqual([]);
  });
});

test.describe("Maui terminology — the engineering surfaces", () => {
  test.use(AS_ADMIN_TERMS);

  test("no employee wording on the admin-only pages either", async ({ page }) => {
    for (const path of ADMIN_PAGES) await expectPatientWording(page, path);
  });
});
