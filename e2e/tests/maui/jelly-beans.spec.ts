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

/**
 * Where a chip lands depends on its bucket (#698). A GAP chip (Overdue, Due Soon, Missing Data) opens
 * the WORK LIST, `/worklist?measureId=…&outcome=…`, for a case manager, which is who this spec signs in
 * as. Compliant and Excluded open the ROSTER, `/compliance?measureId=…&status=…`, since those patients
 * have no gap. Both shapes are read here; a spec that reads a selector nothing renders finds no chips
 * and reports it as a missing feature, which is how an earlier re-pointing went unnoticed.
 */
async function readChips(page: Page, measureId: string): Promise<ChipInfo[]> {
  const chips: ChipInfo[] = [];
  const chipLinks = page.locator(
    `a[href^="/worklist?"][href*="measureId=${measureId}"][href*="outcome="], a[href^="/compliance?"][href*="measureId=${measureId}"][href*="status="]`,
  );
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
    const bucketMatch = href.match(/(?:outcome|status)=([A-Z_]+)/);
    if (!bucketMatch) continue;
    if (!OPEN_BUCKETS.includes(bucketMatch[1] as (typeof OPEN_BUCKETS)[number])) continue;
    // A gap chip leads to the work list (#698); one still pointing at the roster is the regression.
    expect(href, `the ${bucketMatch[1]} chip opens the work list`).toMatch(/^\/worklist\?/);
    // The visible text is "Overdue 7"; the aria-label is prefixed with the crosswalk
    // ("MIPS 112 · CMS125 · …: Overdue 7"), so the count is the LAST number of the visible text.
    //
    // `[\d,]` rather than `\d`, and the difference is a wrong number rather than a failure: the chip
    // groups with `fmtCount`, so the pilot's "Overdue 1,382" read as 382 under the old pattern and the
    // comparison below then asserted that 382 covered a worklist of 1,382. Two digits short of a
    // green suite.
    const text = ((await chip.textContent()) ?? "").trim();
    const countMatch = text.match(/([\d,]+)\s*$/);
    if (!countMatch) continue;
    chips.push({ bucket: bucketMatch[1], count: parseInt(countMatch[1].replace(/,/g, ""), 10), href });
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
    let compared = 0;
    for (const measure of ROUTED_MEASURES) {
      // `readChips` waits for the measure's card itself, which is also the assertion that a routed
      // measure renders one at all.
      const chips = await readChips(page, measure.id);
      expect(chips.length, `${measure.cms} should have at least one open-bucket chip`).toBeGreaterThan(0);

      const worklistLink = page.locator(`a[href*="measureId=${measure.id}"]`).filter({ hasText: /Open cases/i });
      await expect(worklistLink.first()).toBeVisible({ timeout: 10_000 });
      const worklistText = (await worklistLink.first().textContent()) ?? "";
      const worklistTotal = Number(worklistText.match(/([\d,]+)/)?.[1]?.replace(/,/g, ""));
      expect(Number.isFinite(worklistTotal), `${measure.cms}: the worklist link states a count ("${worklistText}")`).toBe(true);
      // A measure can have no open gaps on CI's 48-patient year-to-date corpus (CMS122 counts one
      // diabetic so far this year, in control). It has nothing to compare; the test as a whole must
      // still compare something, or `chipSum >= 0` would pass on nothing (checked after the loop).
      if (worklistTotal === 0) continue;
      compared += 1;

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
    expect(compared, "at least one routed measure has open cases to compare against").toBeGreaterThan(0);
  });

  // The EXPENSIVE structural check — that a chip's href really filters the list it lands on — is worth
  // doing properly, but once. cms125 is the measure whose corpus distribution the pilot was designed
  // around.
  //
  // A gap chip lands on the WORK LIST (#698), whole practice (`panel=all`), and there the count is a
  // BOUND, not an equality: the chip counts the latest population run's patients in that status, and
  // the work list lists those with an OPEN gap of that status now. The list is smaller by gaps staff
  // closed (still counted, #569), by subjects segment gating kept from a case, and at a year's
  // rollover, before the new year's first run. It can only be LARGER if a later single-patient run
  // moved a case into this status after the population run; this spec runs before any spec that
  // writes, so on CI it cannot. A zero chip is not compared: it bounds nothing worth asserting.
  test("a cms125 gap chip drills into a work list filtered to that status, and the filter is URL-backed", async ({ page }) => {
    const chips = await readChips(page, "cms125");
    expect(chips.length).toBeGreaterThan(0);

    for (const chip of chips) {
      await page.goto(chip.href);
      await expect(page).toHaveURL(new RegExp(`/worklist\\?measureId=cms125&outcome=${chip.bucket}`));
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`/worklist\\?measureId=cms125&outcome=${chip.bucket}`));
      await expectNoErrorPage(page);

      if (chip.count === 0) continue;
      // A non-empty bucket must list people. Waited for FIRST: the header reads "0 patients with open
      // gaps" until the list loads, so reading the total before a row appears would pass on nothing.
      await expect(
        page.getByTestId("worklist-patient-id").filter({ visible: true }).first(),
        `a non-empty ${chip.bucket} work list must list patients`,
      ).toBeVisible({ timeout: 30_000 });
      // The work list states its own total ("N patients with open gaps"); the page's number, not a row
      // count, because the list pages.
      const totalLine = page.getByText(/([\d,]+) (patient|patients) with open gaps/).first();
      await expect(totalLine).toBeVisible({ timeout: 30_000 });
      const listed = Number(((await totalLine.textContent()) ?? "").match(/([\d,]+) (?:patient|patients) with open gaps/)?.[1]?.replace(/,/g, ""));
      expect(Number.isFinite(listed), "the work list states its total").toBe(true);
      expect(listed, `the ${chip.bucket} work list (${listed}) cannot hold more than the chip's ${chip.count}`).toBeLessThanOrEqual(chip.count);
      expect(listed, `the ${chip.bucket} work list is not empty`).toBeGreaterThan(0);
    }
  });
});
