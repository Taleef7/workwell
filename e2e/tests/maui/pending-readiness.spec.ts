import { test, expect } from "@playwright/test";
import { API_BASE, AS_ADMIN, AS_QUALITY_LEAD, MAUI_PASSWORD } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

/** Occupational content that must never surface on a patient deployment. */
const OCCUPATIONAL = ["HAZWOPER", "Audiogram", "TB Surveillance"];

test.describe("Maui readiness — signed in", () => {
  test.use(AS_QUALITY_LEAD);

  test("the programs page carries no occupational measures", async ({ page }) => {
    await page.goto("/programs");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    for (const label of OCCUPATIONAL) await expect(page.getByText(label)).not.toBeVisible();
  });
});

test.describe("Maui readiness — the catalog", () => {
  // As the quality lead this page is an AccessDenied panel, so asserting that HAZWOPER is absent from
  // it passed without ever loading a catalog. ADMIN is the role that can see the list this is about.
  test.use(AS_ADMIN);

  test("the measures catalog carries no occupational measures", async ({ page }) => {
    await page.goto("/measures");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    for (const label of OCCUPATIONAL) await expect(page.getByText(label)).not.toBeVisible();
  });
});

test.describe("Maui readiness — signed out", () => {
  // No storage state: these are about what an ANONYMOUS visitor sees.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("no OSHA wording, no public-sandbox affordances, and /sandbox redirects to login", async ({ page }) => {
    await page.goto("/login");
    for (const text of ["OSHA", "Open sandbox", "Skip login"]) {
      await expect(page.getByText(text)).not.toBeVisible();
    }

    await page.goto("/");
    for (const text of ["Open sandbox", "Public sandbox"]) {
      await expect(page.getByText(text)).not.toBeVisible();
    }

    await page.goto("/sandbox");
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test("a TWH account cannot authenticate against the Maui stack", async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: "viewer@workwell.dev", password: MAUI_PASSWORD },
    });
    expect(res.status()).toBe(401);
  });
});
