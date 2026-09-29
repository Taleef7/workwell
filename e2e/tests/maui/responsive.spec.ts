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

const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
] as const;

/** Each route with the element that means its data has painted, so the page is measured loaded. */
const ROUTES: { path: string; ready: (page: Page) => ReturnType<Page["locator"]> }[] = [
  { path: "/programs", ready: (p) => p.getByText(/Open cases \(\d+\)/).first() },
  { path: "/programs/hierarchy", ready: (p) => p.getByText("All Systems").first() },
  { path: "/programs/cms125", ready: (p) => p.getByText(/CMS125/).first() },
  { path: "/worklist", ready: (p) => p.locator("a[href^='/patients/']").first() },
  { path: "/compliance", ready: (p) => p.locator("a[href^='/patients/']").filter({ visible: true }).first() },
  { path: "/cases", ready: (p) => p.getByText(/ of [\d,]+ cases/).first() },
  { path: "/lists", ready: (p) => p.getByRole("heading", { name: /Attributed lists/i }) },
  { path: "/people", ready: (p) => p.locator("a[href^='/people/']").first() },
  { path: "/orders", ready: (p) => p.getByRole("heading").first() },
  { path: "/campaigns", ready: (p) => p.getByRole("heading").first() },
  { path: "/runs", ready: (p) => p.getByRole("heading").first() },
  { path: "/admin", ready: (p) => p.getByRole("heading").first() },
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
        await expect(route.ready(page)).toBeVisible({ timeout: 30_000 });
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
        await expect(page.getByText(/CMS\d+/).first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(1_500);
        const { overflow, offenders } = await sidewaysOverflow(page);
        expect(overflow, `${href} at ${vp.width}px scrolls sideways; sticking out: ${offenders.join(", ")}`).toBeLessThanOrEqual(1);
      }
    });
  });
}
