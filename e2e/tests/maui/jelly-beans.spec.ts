import { test, expect, type Page } from "@playwright/test";
import { AS_QUALITY_LEAD_CHIPS, ROUTED_MEASURES, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.use(AS_QUALITY_LEAD_CHIPS);

const OPEN_BUCKETS = ["DUE_SOON", "OVERDUE", "MISSING_DATA"] as const;

interface ChipInfo {
  bucket: string;
  count: number;
  href: string;
}

async function readChips(page: Page, measureId: string): Promise<ChipInfo[]> {
  const chips: ChipInfo[] = [];
  const chipLinks = page.locator(`a[href*="measureId=${measureId}"][href*="outcome="]`);
  // Wait for the cards BEFORE counting. `locator.count()` is a snapshot, and the describe's beforeEach
  // only waits for a heading — which renders before the measure cards have their data. Reading here
  // without this returned zero chips on a slow load, and the caller's `chips.length > 0` then failed as
  // "flaky" while the page was simply not ready yet.
  await expect(chipLinks.first(), `${measureId} should render status chips`).toBeVisible({ timeout: 30_000 });
  const count = await chipLinks.count();
  for (let i = 0; i < count; i++) {
    const chip = chipLinks.nth(i);
    const href = await chip.getAttribute("href");
    if (!href) continue;
    const bucketMatch = href.match(/outcome=([A-Z_]+)/);
    if (!bucketMatch) continue;
    if (!OPEN_BUCKETS.includes(bucketMatch[1] as (typeof OPEN_BUCKETS)[number])) continue;
    // The visible text is "Overdue 7"; the aria-label is prefixed with the crosswalk
    // ("MIPS 112 · CMS125 · …: Overdue 7"), so the count is the LAST number of the visible text.
    const text = ((await chip.textContent()) ?? "").trim();
    const countMatch = text.match(/(\d+)\s*$/);
    if (!countMatch) continue;
    chips.push({ bucket: bucketMatch[1], count: parseInt(countMatch[1], 10), href });
  }
  return chips;
}

test.describe("Maui status chips (jelly beans)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/programs");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
  });

  // CHEAP pass over every routed measure: each one renders chips, and the chips are consistent with
  // the worklist link beside them. This replaces a per-measure drill-down that navigated and reloaded
  // once per chip — six measures × three buckets × two page loads was most of the project's runtime.
  test("every routed measure renders status chips consistent with its worklist", async ({ page }) => {
    for (const measure of ROUTED_MEASURES) {
      // `readChips` waits for the measure's card itself, which is also the assertion that a routed
      // measure renders one at all.
      const chips = await readChips(page, measure.id);
      expect(chips.length, `${measure.cms} should have at least one open-bucket chip`).toBeGreaterThan(0);

      const worklistLink = page.locator(`a[href*="measureId=${measure.id}"]`).filter({ hasText: /Open Worklist/i });
      await expect(worklistLink.first()).toBeVisible({ timeout: 10_000 });
      const worklistTotal = Number(((await worklistLink.first().textContent()) ?? "").match(/(\d+)/)?.[1]);
      // Without this, `chipSum >= worklistTotal` is satisfied by any chip sum whenever the worklist
      // renders 0 — including a sum computed from nothing.
      expect(worklistTotal, `${measure.cms} should have open cases to compare against`).toBeGreaterThan(0);

      // NOT equality. A chip counts OUTCOMES in a bucket; the worklist counts CASES. Since ADR-078 a
      // subject the official executor puts outside the initial population is persisted MISSING_DATA
      // but opens no case, so on every officially routed measure the chip sum is the larger number.
      // Asserting equality here is asserting the fan-out ADR-078 removed.
      const chipSum = chips.reduce((sum, c) => sum + c.count, 0);
      expect(
        chipSum,
        `${measure.cms}: chip sum (${chipSum}) must cover the open worklist (${worklistTotal}); the gap is out-of-population subjects`,
      ).toBeGreaterThanOrEqual(worklistTotal);
    }
  });

  // The EXPENSIVE structural check — that a chip's href really filters the case list — is worth doing
  // properly, but once. cms125 is the measure whose corpus distribution the pilot was designed around.
  test("a cms125 chip drills into a case list filtered to that bucket, and the filter is URL-backed", async ({ page }) => {
    const chips = await readChips(page, "cms125");
    expect(chips.length).toBeGreaterThan(0);

    for (const chip of chips) {
      await page.goto(chip.href);
      await expect(page).toHaveURL(new RegExp(`measureId=cms125&outcome=${chip.bucket}`));
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`measureId=cms125&outcome=${chip.bucket}`));
      await expectNoErrorPage(page);

      // Wait for the list to settle: either a visible case link or one of the page's empty states.
      const firstCase = page.locator("a[href^='/cases/']").filter({ visible: true }).first();
      const emptyState = page.getByText(/^No (open |excluded |closed )?cases|^No results match/);
      await expect(firstCase.or(emptyState)).toBeVisible({ timeout: 30_000 });

      // Count DISTINCT cases: a row renders more than one link to the same case (name + "View"),
      // and the mobile card layout duplicates rows in the DOM.
      const hrefs = await page.locator("a[href^='/cases/']").evaluateAll((els) =>
        els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
      );
      const rowCount = new Set(hrefs.filter((h) => /^\/cases\/[^?]+$/.test(h))).size;
      // A bound rather than equality, for the ADR-078 reason: the bucket's outcomes include subjects
      // outside the population, who have no case to list.
      expect(
        rowCount,
        `cases listed (${rowCount}) must not exceed the ${chip.bucket} chip (${chip.count})`,
      ).toBeLessThanOrEqual(chip.count);
      // ...but the ceiling ALONE passes at zero, which is what a chip href that stopped applying its
      // filter would produce — the settle-wait above deliberately accepts the empty state, so nothing
      // else would catch it. The out-of-population relaxation only explains MISSING_DATA: every
      // IN-population OVERDUE or DUE_SOON outcome opens a case, so a non-empty chip must list some.
      if (chip.bucket !== "MISSING_DATA" && chip.count > 0) {
        expect(rowCount, `a non-empty ${chip.bucket} chip must list cases`).toBeGreaterThan(0);
      }
    }
  });
});
