import { test, expect, type Page } from "@playwright/test";
import { AS_ADMIN_RESPONSIVE, expectNoErrorPage } from "./helpers";

/**
 * No screen scrolls sideways on a phone or a tablet (#700) — READ-ONLY.
 *
 * Every other spec runs at 1280px, where all of these pages fit, so a page that slid sideways on a
 * phone went unnoticed: Programs overflowed by 506px at 375 (and 121px at 768), Campaigns by 316px, the
 * patient page by 113px. jsdom has no layout, so no unit test can catch it; this measures the real page.
 *
 * A wide TABLE may still scroll inside its own labelled region (`ScrollRegion`); what must never happen
 * is `<main>` itself scrolling sideways, which moves the whole page, headings and all.
 */
test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.use(AS_ADMIN_RESPONSIVE);

// 320 is the smallest phone still in use (iPhone SE, 1st gen); at 375 the case page's Assignee row and the
// Runs filters fitted, at 320 they did not.
const VIEWPORTS = [
  { name: "small phone", width: 320, height: 568 },
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
] as const;

/**
 * Each route with a wait for its DATA, not its heading: a heading paints before any fetch, and a page
 * measured before its table or its options arrive passes whatever the layout does.
 */
const T = { timeout: 30_000 };
const ROUTES: { path: string; ready: (page: Page) => Promise<void> }[] = [
  { path: "/programs", ready: (p) => expect(p.getByText(/Open cases \(\d+\)/).first()).toBeVisible(T) },
  // Inside the table: the System filter's "All systems" <option> comes first in the DOM, and the top row
  // names "All Systems" twice (its name and its level tag).
  { path: "/programs/hierarchy", ready: (p) => expect(p.getByRole("table").getByText("All Systems", { exact: true }).first()).toBeVisible(T) },
  { path: "/programs/cms125", ready: (p) => expect(p.getByText(/CMS125/).filter({ visible: true }).first()).toBeVisible(T) },
  { path: "/worklist", ready: (p) => expect(p.locator("a[href^='/patients/']").first()).toBeVisible(T) },
  { path: "/compliance", ready: (p) => expect(p.locator("a[href^='/patients/']").filter({ visible: true }).first()).toBeVisible(T) },
  // "N of M cases" only when there is a next page; "N cases loaded" otherwise.
  { path: "/cases", ready: (p) => expect(p.getByText(/\d+ of [\d,]+ cases|\d+ cases? loaded/).first()).toBeVisible(T) },
  { path: "/lists", ready: (p) => expect(p.getByRole("button", { name: /^(Open|Hide)$/ }).or(p.getByText("No attributed lists yet.")).first()).toBeVisible(T) },
  { path: "/people", ready: (p) => expect(p.locator("a[href^='/people/']").first()).toBeVisible(T) },
  { path: "/orders", ready: (p) => expect(p.locator("table").or(p.getByText("No suppressed orders on this page.")).first()).toBeVisible(T) },
  // The measure options come from the API, and a long one is what widened this page.
  { path: "/campaigns", ready: (p) => expect(p.locator("#campaign-measure option").nth(1)).toBeAttached(T) },
  { path: "/runs", ready: (p) => expect(p.getByRole("button", { name: /View run details for/ }).first()).toBeVisible(T) },
  { path: "/admin", ready: (p) => expect(p.getByText("Measure evaluation").first()).toBeVisible(T) },
];

/** How far `<main>` scrolls sideways, and the outermost elements that stick out of it. */
async function sidewaysOverflow(page: Page): Promise<{ overflow: number; offenders: string[] }> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return { overflow: 0, offenders: ["no <main>"] };
    const edge = main.getBoundingClientRect().right;
    const sticksOut = (el: Element) => el.getBoundingClientRect().right > edge + 1 && el.getBoundingClientRect().width > 0;
    const offenders = [...main.querySelectorAll("*")]
      .filter((el) => sticksOut(el) && !(el.parentElement && el.parentElement !== main && sticksOut(el.parentElement)))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)}`);
    return { overflow: main.scrollWidth - main.clientWidth, offenders };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`at ${vp.width}px (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const route of ROUTES) {
      test(`${route.path} does not scroll sideways`, async ({ page }) => {
        await page.goto(route.path);
        await route.ready(page);
        await expectNoErrorPage(page);
        // Let late content (trend charts, the measure catalog's labels) settle before measuring.
        await page.waitForTimeout(1_500);
        const { overflow, offenders } = await sidewaysOverflow(page);
        expect(overflow, `${route.path} at ${vp.width}px scrolls sideways; sticking out: ${offenders.join(", ")}`).toBeLessThanOrEqual(1);
      });
    }

    test("a patient page and a case page do not scroll sideways", async ({ page }) => {
      await page.goto("/worklist");
      const patient = page.locator("a[href^='/patients/']").first();
      await expect(patient).toBeVisible({ timeout: 30_000 });
      const caseHref = await page.locator("a[href^='/cases/']").first().getAttribute("href");
      for (const href of [await patient.getAttribute("href"), caseHref]) {
        expect(href, "the work list links a patient and a case").toBeTruthy();
        await page.goto(href!);
        // Visible only: a page may also carry a CSS-hidden copy for another width.
        await expect(page.getByText(/CMS\d+/).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(1_500);
        const { overflow, offenders } = await sidewaysOverflow(page);
        expect(overflow, `${href} at ${vp.width}px scrolls sideways; sticking out: ${offenders.join(", ")}`).toBeLessThanOrEqual(1);
      }
    });
  });
}
