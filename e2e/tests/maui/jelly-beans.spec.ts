import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, loginAs, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

const OPEN_BUCKETS = ["DUE_SOON", "OVERDUE", "MISSING_DATA"] as const;

const MEASURES = [
  { id: "cms125", label: "Breast Cancer Screening" },
  { id: "cms122", label: "Diabetes" },
  { id: "hypertension", label: "Hypertension" },
] as const;

interface ChipInfo {
  bucket: string;
  count: number;
  href: string;
}

async function readChips(page: import("@playwright/test").Page, measureId: string): Promise<ChipInfo[]> {
  const chips: ChipInfo[] = [];
  const chipLinks = page.locator(`a[href*="measureId=${measureId}"][href*="outcome="]`);
  const count = await chipLinks.count();
  for (let i = 0; i < count; i++) {
    const chip = chipLinks.nth(i);
    const href = await chip.getAttribute("href");
    if (!href) continue;
    const bucketMatch = href.match(/outcome=([A-Z_]+)/);
    if (!bucketMatch) continue;
    if (!OPEN_BUCKETS.includes(bucketMatch[1] as (typeof OPEN_BUCKETS)[number])) continue;
    const ariaLabel = (await chip.getAttribute("aria-label")) ?? "";
    const countMatch = ariaLabel.match(/(\d+)/);
    if (!countMatch) continue;
    chips.push({ bucket: bucketMatch[1], count: parseInt(countMatch[1], 10), href });
  }
  return chips;
}

test.describe("Maui status chips (jelly beans)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);
    await page.goto("/programs");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
  });

  for (const measure of MEASURES) {
    test(`${measure.id}: chip counts match case list and Open Worklist`, async ({ page }) => {
      await expect(page.locator(`a[href*="measureId=${measure.id}"][href*="outcome="]`).first()).toBeVisible({ timeout: 30_000 });
      const chips = await readChips(page, measure.id);
      test.expect(chips.length).toBeGreaterThan(0);

      // Open Worklist total for this measure
      const worklistLink = page.locator(`a[href*="measureId=${measure.id}"]`).filter({ hasText: /Open Worklist/i });
      await expect(worklistLink.first()).toBeVisible({ timeout: 10_000 });
      const wlText = await worklistLink.first().textContent();
      const wlMatch = wlText?.match(/(\d+)/);
      expect(wlMatch, "Open Worklist should include its case count").not.toBeNull();
      const worklistTotal = Number(wlMatch?.[1]);

      const chipSum = chips.reduce((sum, c) => sum + c.count, 0);
      expect(chipSum, `chip sum (${chipSum}) should equal Open Worklist (${worklistTotal})`).toBe(worklistTotal);

      for (const chip of chips) {
        await page.goto(chip.href);
        await expect(page).toHaveURL(new RegExp(`measureId=${measure.id}&outcome=${chip.bucket}`));
        await expectNoErrorPage(page);

        // Reload to confirm filters are URL-backed and survive refresh
        await page.reload();
        await expect(page).toHaveURL(new RegExp(`measureId=${measure.id}&outcome=${chip.bucket}`));
        await expect(page.locator("tbody tr").first().or(page.getByText("No cases match these filters."))).toBeVisible({ timeout: 30_000 });

        // Count visible case rows matching this measure+outcome
        const caseRows = page.locator("a[href^='/cases/']").filter({ visible: true });
        const rowCount = await caseRows.count();
        expect(rowCount, `case rows (${rowCount}) should match chip count (${chip.count}) for ${chip.bucket}`).toBe(chip.count);
      }
    });
  }

  test("filters survive reload (URL-backed)", async ({ page }) => {
    await expect(page.locator('a[href*="measureId=cms125"][href*="outcome="]').first()).toBeVisible({ timeout: 30_000 });
    const chips = await readChips(page, "cms125");
    test.expect(chips.length).toBeGreaterThan(0);
    const chip = chips[0];
    await page.goto(chip.href);
    await expect(page).toHaveURL(new RegExp(`measureId=cms125&outcome=${chip.bucket}`));
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`measureId=cms125&outcome=${chip.bucket}`));
    await expectNoErrorPage(page);
  });
});
