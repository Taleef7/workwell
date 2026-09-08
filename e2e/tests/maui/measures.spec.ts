import { test, expect } from "@playwright/test";
import { AS_ADMIN_MEASURES, AS_QUALITY_LEAD_MEASURE, ROUTED_MEASURES, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.describe("Maui measures catalog", () => {
  // /measures is an ENGINEERING surface: on the pilot profile `canSeeEngineering` admits ADMIN only,
  // so the quality lead gets an AccessDenied panel and no catalog. The spec used to sign in as the
  // quality lead and wait 20s for a crosswalk label that was never going to render.
  test.use(AS_ADMIN_MEASURES);

  test("the identity column carries the MIPS crosswalk for every routed measure", async ({ page }) => {
    await page.goto("/measures");
    for (const m of ROUTED_MEASURES) {
      await expect(page.getByText(`MIPS ${m.mips} · ${m.cms}`).first()).toBeVisible({ timeout: 20_000 });
    }
    await expectNoErrorPage(page);
  });
});

test.describe("Maui measure detail", () => {
  // The per-measure page is NOT engineering-gated — it is where the quality lead reads a measure.
  test.use(AS_QUALITY_LEAD_MEASURE);

  test("measure detail for cms125 opens without error", async ({ page }) => {
    await page.goto("/programs/cms125");
    await expectNoErrorPage(page);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
  });
});
