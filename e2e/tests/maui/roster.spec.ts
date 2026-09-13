import { test, expect } from "@playwright/test";
import {
  AS_QUALITY_LEAD_ROSTER,
  ROUTED_MEASURES,
  expectNoErrorPage,
  fetchPanels,
  getAuthToken,
  grouped,
  rosterTotal,
  statedRosterTotal,
} from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

// The roster is the quality lead's page; the session comes from global setup rather than a sign-in
// per test.
test.use(AS_QUALITY_LEAD_ROSTER);

/** Land on the roster and wait for the page, not for an arbitrary timeout. */
async function openRoster(page: import("@playwright/test").Page, query = "") {
  await page.goto(`/compliance${query}`);
  await expect(page.getByRole("heading", { name: /Individual Compliance/i })).toBeVisible({ timeout: 20_000 });
}

test.describe("Maui compliance roster", () => {
  test("shows the whole roster, the ACO's routed measure columns, and no occupational ones", async ({ page, request }) => {
    // The roster's size is ASKED, never written down: CI composes 48 corpus patients and the pilot
    // sandbox composes 20,000 (`WORKWELL_MAUI_CORPUS_SIZE`). This file asserted "48" four times, so it
    // could only ever be run against one of the two stacks it is meant to cover.
    const total = await rosterTotal(request, await getAuthToken(request));
    await openRoster(page);

    // Three assertions that used to be three page loads: every patient the panel holds, one column per
    // RUNNABLE measure (ADR-072), and nothing from the occupational catalog.
    await expect(page.getByText(new RegExp(`^${grouped(total)} (patient|patients)\\b`)).last()).toBeVisible({
      timeout: 20_000,
    });

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

  /**
   * Each of these asks the SERVER what the filtered roster holds and then polls the page to that exact
   * number. Polling for "less than the whole roster" instead looks like the same assertion and is not:
   * a refetch renders "0 patients" for a moment, which satisfies "fewer" — so the test would pass on a
   * filter that returned nothing, and its floor check would then race the same load. That is the
   * vacuous shape this file was being repaired for, one layer in.
   */
  test("status filter narrows the roster", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const total = await rosterTotal(request, token);
    const overdue = await rosterTotal(request, token, "status=OVERDUE");
    expect(overdue, "the filter must MATCH, not just narrow").toBeGreaterThan(0);
    expect(overdue).toBeLessThan(total);

    await openRoster(page);
    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(total);

    await page.getByLabel("Status", { exact: true }).selectOption({ label: "Overdue" });

    // The TOTAL, not the visible row count: the roster pages at 50 rows, so on the pilot's corpus both
    // the filtered and unfiltered lists render a full page and a row count compares two 50s.
    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(overdue);
    expect(await page.locator("tbody tr").count()).toBeGreaterThan(0);
  });

  test("site filter narrows to Kihei Clinic", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const total = await rosterTotal(request, token);
    const kihei = await rosterTotal(request, token, `site=${encodeURIComponent("Kihei Clinic")}`);
    expect(kihei, "one clinic still holds patients").toBeGreaterThan(0);
    expect(kihei).toBeLessThan(total);

    await openRoster(page);

    // The site filter is the GLOBAL header filter (a custom combobox, rendered twice for the
    // responsive layouts), not a roster control. The roster footer reads "<total> patients".
    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(total);

    const siteFilter = page.getByRole("combobox", { name: "Filter by site" }).filter({ visible: true }).first();
    await siteFilter.click();
    // EXACT, or this matches an <option> of the PCP select — "Dr. Ines Souza — Kihei Clinic" also has
    // role=option, sorts earlier in the DOM, and is inside a closed native select, so the click waited
    // out its full timeout on an element that can never be visible.
    await page.getByRole("option", { name: "Kihei Clinic", exact: true }).first().click();

    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(kihei);
  });

  test("search narrows rows, and a patient name opens their profile", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const total = await rosterTotal(request, token);
    await openRoster(page);

    // Search for a patient this roster ACTUALLY holds, read off the page. The name used to be written
    // into the spec ("Ari Wren"), which is a patient of the 48-person CI corpus and nobody at all on
    // the pilot's 20,000 — so the search returned an empty list and the floor assertion below reported
    // a working filter as broken.
    const someone = (await page.locator("a[href^='/employees/']").first().innerText()).trim();
    expect(someone.length, "the roster renders a patient to search for").toBeGreaterThan(0);

    // The server's answer for this exact search, so the page is checked against a number rather than
    // against "smaller" — which a mid-refetch zero satisfies.
    const matches = await rosterTotal(request, token, `q=${encodeURIComponent(someone)}`);
    expect(matches, "the search must MATCH, not just narrow").toBeGreaterThan(0);
    expect(matches).toBeLessThan(total);

    const searchInput = page.getByPlaceholder("Name or ID");
    await searchInput.fill(someone);
    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(matches);

    await searchInput.fill("");
    const patientLink = page.locator("a[href^='/employees/']").filter({ visible: true }).first();
    await expect(patientLink).toBeVisible({ timeout: 20_000 });
    await patientLink.click();
    await expect(page).toHaveURL(/\/employees\//);
    await expectNoErrorPage(page);

    // WAIT for the measure content rather than reading the body the instant the route resolves. The
    // profile's measures arrive in a second request, so on the pilot's stack this read landed on a
    // page that had rendered its header and nothing else, and reported a loading page as a profile
    // that knows nothing about the pilot's measures.
    const pilotMeasure = /CMS122|CMS125|CMS2|CMS130|CMS165|CMS137|Diabetes|Breast|Colorectal|Blood Pressure/i;
    await expect(
      page.getByText(pilotMeasure).first(),
      "patient profile should reference at least one pilot measure",
    ).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("Maui roster panel filters", () => {
  test("selecting a PCP narrows the roster to that panel and carries providerId in the URL", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const before = await rosterTotal(request, token);
    await openRoster(page);
    expect(before, "the unfiltered roster must have patients for this to mean anything").toBeGreaterThan(1);

    // A provider who actually HAS patients, asked of the directory rather than taken as the first
    // option in the list. The select offers every provider in the practice, and on the 48-patient CI
    // corpus most of them have nobody — so picking option two chose an empty panel, and "the filter
    // narrowed the list" was then satisfied by a filter that returned nothing. CI found this; on the
    // 20,000-patient sandbox that provider happened to have patients and the test looked sound.
    const panels = await fetchPanels(request, token);
    const target = panels.find((p) => p.patients > 0);
    expect(target, "some provider must have patients for a panel filter to mean anything").toBeTruthy();
    const providerId = target!.providerId;

    // Resolved by the select's own aria-label. Until 2026-09-08 these filters carried only a wrapping
    // <label>, and Chrome computed no accessible name for them, so the lookup found nothing.
    const pcpSelect = page.getByLabel(/^PCP$/);
    await expect(pcpSelect).toBeVisible({ timeout: 10_000 });
    // By VALUE, so the assertion below is about the id the backend filters on, not a display name.
    await pcpSelect.selectOption(providerId);

    await expect(page).toHaveURL(new RegExp(`providerId=${providerId}`), { timeout: 20_000 });
    await expect(page.getByText(/^Filtered to$/)).toBeVisible({ timeout: 20_000 });
    // Again the stated TOTAL rather than the rendered rows: one provider's panel is several hundred
    // patients on the pilot corpus, so both lists render a full page of 50 and comparing them compares
    // the page size with itself. And the server's number for this panel rather than "smaller than the
    // practice", which a mid-refetch zero also satisfies.
    const panelTotal = await rosterTotal(request, token, `providerId=${encodeURIComponent(providerId)}`);
    expect(panelTotal, "the chosen panel holds patients").toBeGreaterThan(0);
    expect(panelTotal).toBeLessThan(before);
    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(panelTotal);

    await expectNoErrorPage(page);
  });

  test("a deep link with all three filters renders filtered, and Clear restores the whole roster", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const whole = await rosterTotal(request, token);
    // The number the server gives for exactly this link, so the assertion below is "the page shows the
    // filtered set" rather than "the page shows something smaller" — which a still-loading 0 satisfies.
    const expected = await rosterTotal(request, token, "ageBand=65%2B&sex=F");
    expect(expected, "the deep link must filter to a real subset").toBeLessThan(whole);

    await page.goto("/compliance?ageBand=65%2B&sex=F");
    await expect(page.getByText(/^Filtered to$/)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(expected);

    await page.getByRole("button", { name: /^Clear$/ }).first().click();
    await expect(page.getByText(/^Filtered to$/)).toBeHidden({ timeout: 20_000 });
    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(whole);

    await expectNoErrorPage(page);
  });
});
