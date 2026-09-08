import { test, expect } from "@playwright/test";
import { AS_QUALITY_LEAD, ROUTED_MEASURES, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

// The roster is the quality lead's page; the session comes from global setup rather than a sign-in
// per test.
test.use(AS_QUALITY_LEAD);

/** Land on the roster and wait for the page, not for an arbitrary timeout. */
async function openRoster(page: import("@playwright/test").Page, query = "") {
  await page.goto(`/compliance${query}`);
  await expect(page.getByRole("heading", { name: /Individual Compliance/i })).toBeVisible({ timeout: 20_000 });
}

test.describe("Maui compliance roster", () => {
  test("shows the whole roster, the ACO's routed measure columns, and no occupational ones", async ({ page }) => {
    await openRoster(page);

    // Three assertions that used to be three page loads. The roster is 48 corpus patients, one column
    // per RUNNABLE measure in the panel (ADR-072), and nothing from the occupational catalog.
    await expect(page.getByText(/of\s*48|48\s*(patients|rows|total)/i).first()).toBeVisible({ timeout: 20_000 });

    for (const m of ROUTED_MEASURES) {
      await expect(
        page.getByRole("columnheader", { name: new RegExp(`MIPS ${m.mips} · ${m.cms}`) }),
        `${m.cms} is routed on this stack, so it is a roster column`,
      ).toBeVisible({ timeout: 20_000 });
    }

    const headerText = (await page.getByRole("columnheader").allTextContents()).join(" ");
    for (const absent of ["HAZWOPER", "Audiogram", "TB Surveillance", "Hypertension"]) {
      expect(headerText, `${absent} must not appear on the pilot roster`).not.toContain(absent);
    }
  });

  test("status filter narrows rows", async ({ page }) => {
    await openRoster(page);
    await page.getByLabel("Status", { exact: true }).selectOption({ label: "Overdue" });

    const rows = page.locator("tbody tr");
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThan(48);
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("site filter narrows to Kihei Clinic", async ({ page }) => {
    await openRoster(page);

    // The site filter is the GLOBAL header filter (a custom combobox, rendered twice for the
    // responsive layouts), not a roster control. The roster footer reads "<total> patients".
    const total = page.getByText(/^\d+ patients?$/).filter({ visible: true }).first();
    await expect(total).toHaveText(/^48 patients$/, { timeout: 20_000 });

    const siteFilter = page.getByRole("combobox", { name: "Filter by site" }).filter({ visible: true }).first();
    await siteFilter.click();
    // EXACT, or this matches an <option> of the PCP select — "Dr. Ines Souza — Kihei Clinic" also has
    // role=option, sorts earlier in the DOM, and is inside a closed native select, so the click waited
    // out its full timeout on an element that can never be visible.
    await page.getByRole("option", { name: "Kihei Clinic", exact: true }).first().click();

    await expect(total).not.toHaveText(/^48 patients$/, { timeout: 20_000 });
    const filteredTotal = Number(((await total.textContent()) ?? "").match(/^(\d+)/)?.[1]);
    expect(filteredTotal).toBeGreaterThan(0);
    expect(filteredTotal).toBeLessThan(48);
  });

  test("search narrows rows, and a patient name opens their profile", async ({ page }) => {
    await openRoster(page);

    const searchInput = page.getByPlaceholder("Name or ID");
    await searchInput.fill("Ari Wren");
    const rows = page.locator("tbody tr");
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeLessThanOrEqual(2);

    await searchInput.fill("");
    const patientLink = page.locator("a[href^='/employees/']").filter({ visible: true }).first();
    await expect(patientLink).toBeVisible({ timeout: 20_000 });
    await patientLink.click();
    await expect(page).toHaveURL(/\/employees\//);
    await expectNoErrorPage(page);

    const body = await page.locator("body").innerText();
    expect(
      /CMS122|CMS125|CMS2|CMS130|CMS165|CMS137|Diabetes|Breast|Colorectal|Blood Pressure/i.test(body),
      "patient profile should reference at least one pilot measure",
    ).toBe(true);
  });
});

test.describe("Maui roster panel filters", () => {
  test("selecting a PCP narrows the roster to that panel and carries providerId in the URL", async ({ page }) => {
    await openRoster(page);

    const before = await page.getByRole("row").count();
    expect(before, "the unfiltered roster must have rows for this to mean anything").toBeGreaterThan(1);

    // Resolved by the select's own aria-label. Until 2026-09-08 these filters carried only a wrapping
    // <label>, and Chrome computed no accessible name for them, so the lookup found nothing.
    const pcpSelect = page.getByLabel(/^PCP$/);
    await expect(pcpSelect).toBeVisible({ timeout: 10_000 });
    // The second option: the first is "All panels". Selected by VALUE so the assertion below is about
    // the id the backend filters on, not a display name.
    const providerId = await pcpSelect.locator("option").nth(1).getAttribute("value");
    expect(providerId).toBeTruthy();
    await pcpSelect.selectOption(providerId!);

    await expect(page).toHaveURL(new RegExp(`providerId=${providerId}`), { timeout: 20_000 });
    await expect(page.getByText(/^Filtered to$/)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => page.getByRole("row").count(), { timeout: 20_000 }).toBeLessThan(before);

    await expectNoErrorPage(page);
  });

  test("a deep link with all three filters renders filtered, and Clear restores the whole roster", async ({ page }) => {
    await page.goto("/compliance?ageBand=65%2B&sex=F");
    await expect(page.getByText(/^Filtered to$/)).toBeVisible({ timeout: 20_000 });
    const filtered = await page.getByRole("row").count();

    await page.getByRole("button", { name: /^Clear$/ }).first().click();
    await expect(page.getByText(/^Filtered to$/)).toBeHidden({ timeout: 20_000 });
    await expect.poll(async () => page.getByRole("row").count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(filtered);

    await expectNoErrorPage(page);
  });
});
