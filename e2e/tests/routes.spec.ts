import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, loginAs, expectNoErrorPage } from "./helpers";

// Every dashboard route renders its main heading without error text.
const ROUTES: Array<{ path: string; heading: RegExp }> = [
  { path: "/programs", heading: /Programs Overview/i },
  { path: "/programs/hierarchy", heading: /Compliance Hierarchy/i },
  { path: "/compliance", heading: /Individual Compliance Status/i },
  { path: "/runs", heading: /Run History/i },
  { path: "/cases", heading: /Why Flagged cases/i },
  { path: "/campaigns", heading: /Outreach Campaigns/i },
  { path: "/orders", heading: /Order Proposals/i },
  { path: "/people", heading: /People/i },
  { path: "/measures", heading: /Measures/i },
  { path: "/admin", heading: /Operations, waivers, and audit access/i },
  // Measure-specific program page (audiogram is a seeded Active measure).
  { path: "/programs/audiogram", heading: /Audiogram/i },
];

test.describe("Dashboard route sweep (admin)", () => {
  for (const route of ROUTES) {
    test(`${route.path} renders its heading without error`, async ({ page }) => {
      await loginAs(page, ADMIN_EMAIL);
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.path} should return HTTP 200`).toBe(200);
      await expect(
        page.getByRole("heading", { name: route.heading }).first()
      ).toBeVisible({ timeout: 20_000 });
      await expectNoErrorPage(page);
    });
  }

  test("case detail page loads from the cases list", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/cases");
    // The first match may sit in the hidden mobile-card layout — take the visible one.
    const caseLink = page.locator("a[href^='/cases/']").filter({ visible: true }).first();
    await expect(caseLink).toBeVisible({ timeout: 20_000 });
    await caseLink.click();
    await expect(page).toHaveURL(/\/cases\/[0-9a-f-]{36}/);
    await expect(page.getByText(/Audit timeline/i).first()).toBeVisible({ timeout: 20_000 });
    await expectNoErrorPage(page);
  });

  test("employee profile loads from a case detail page", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/cases");
    const caseLink = page.locator("a[href^='/cases/']").filter({ visible: true }).first();
    await expect(caseLink).toBeVisible({ timeout: 20_000 });
    await caseLink.click();
    // Desktop layout links the employee name itself; mobile has an "Open Employee Profile" link.
    const employeeLink = page.locator("a[href^='/employees/']").filter({ visible: true }).first();
    await expect(employeeLink).toBeVisible({ timeout: 20_000 });
    await employeeLink.click();
    await expect(page).toHaveURL(/\/employees\//);
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 20_000 });
    await expectNoErrorPage(page);
  });

  test("studio page loads for the audiogram measure", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    const response = await page.goto("/studio/audiogram");
    expect(response?.status()).toBe(200);
    // Studio tab strip is the page's signature UI.
    await expect(page.getByRole("tab", { name: "Spec" })).toBeVisible({ timeout: 20_000 });
    await expectNoErrorPage(page);
  });
});
