import { test, expect, type Page } from "@playwright/test";
import { AS_QUALITY_LEAD_CHIPS, ROUTED_MEASURES, expectNoErrorPage, grouped } from "./helpers";

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
 * A chip's href carries `status=`, not `outcome=`, and lands on the ROSTER rather than the case list.
 *
 * It was `/cases?measureId=…&outcome=…` when this spec was written, and the "every chip drills into
 * the roster" change re-pointed it at `/compliance?measureId=…&status=…`
 * (`frontend/app/(dashboard)/programs/page.tsx`, `chipHref`). Nothing failed, because the Maui e2e job
 * is dispatch-only and nobody had dispatched it since — a spec that reads a selector nothing renders
 * finds no chips and reports it as a missing feature.
 */
async function readChips(page: Page, measureId: string): Promise<ChipInfo[]> {
  const chips: ChipInfo[] = [];
  const chipLinks = page.locator(`a[href*="measureId=${measureId}"][href*="status="]`);
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
    const bucketMatch = href.match(/status=([A-Z_]+)/);
    if (!bucketMatch) continue;
    if (!OPEN_BUCKETS.includes(bucketMatch[1] as (typeof OPEN_BUCKETS)[number])) continue;
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
  // A chip lands on the ROSTER now, and against the roster the count is an EQUALITY rather than a
  // bound: both numbers count the same latest run's outcomes for that measure in that status, and the
  // out-of-population subjects that used to make this inexact are their own bucket since ADR-079.
  // Measured on the pilot sandbox on 2026-09-13, where the two agree exactly for every bucket —
  // 1,382 overdue, 3,577 compliant, 169 excluded, 14,872 out of population, 0 due soon, 0 missing.
  test("a cms125 chip drills into a roster filtered to that bucket, and the filter is URL-backed", async ({ page }) => {
    const chips = await readChips(page, "cms125");
    expect(chips.length).toBeGreaterThan(0);

    for (const chip of chips) {
      await page.goto(chip.href);
      await expect(page).toHaveURL(new RegExp(`measureId=cms125&status=${chip.bucket}`));
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`measureId=cms125&status=${chip.bucket}`));
      await expectNoErrorPage(page);

      // The roster states its own total. Asserting the page's number rather than counting its rows is
      // what makes this work at both sizes: the roster pages at 50 rows, so a row count says nothing
      // about a bucket of 1,382 beyond "the page is full".
      await expect(
        page.getByText(new RegExp(`^${grouped(chip.count)} (patient|patients)\\b`)).last(),
        `the ${chip.bucket} roster must hold exactly the ${chip.bucket} chip's ${chip.count}`,
      ).toBeVisible({ timeout: 30_000 });

      // ...and a non-empty bucket must actually render people, or an empty list under a correct total
      // would pass. Every one of these buckets is a real patient with a real row.
      if (chip.count > 0) {
        await expect(
          page.locator("a[href^='/employees/']").filter({ visible: true }).first(),
          `a non-empty ${chip.bucket} chip must list patients`,
        ).toBeVisible({ timeout: 30_000 });
      }
    }
  });
});
