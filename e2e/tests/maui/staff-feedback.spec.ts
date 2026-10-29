import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  AS_QUALITY_LEAD_FEEDBACK,
  MAUI_ACCOUNTS,
  expectNoErrorPage,
  fetchPanels,
  getAuthToken,
  waitForDataRows,
} from "./helpers";

/**
 * The pilot group's sandbox findings of 2026-10-22, each driven the way a quality staffer meets it (#865).
 * READ-ONLY: nothing here assigns, sends or saves; "Select all N matching" is a read, and the spec clears
 * it again.
 *
 * Counts and names are read from the stack, never written down: CI carries 48 corpus patients and the
 * sandbox 20,000, and each test has to mean the same thing on both.
 */

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.use(AS_QUALITY_LEAD_FEEDBACK);

/** The first patient the work list shows, by the link the page itself draws to their page. */
async function firstWorklistPatient(page: Page): Promise<string> {
  await page.goto("/worklist");
  await waitForDataRows(page);
  const href = await page.locator("tbody tr a[href^='/patients/']").first().getAttribute("href");
  expect(href, "a work list row links to its patient").toMatch(/^\/patients\/[^/]+$/);
  return decodeURIComponent(href!.slice("/patients/".length));
}

function searchBox(page: Page) {
  return page.getByRole("textbox", { name: /search patients/i }).filter({ visible: true }).first();
}

/** The open result list under the header search (the box's own container holds it). */
function searchResults(page: Page) {
  return searchBox(page).locator("xpath=../..").locator("li button");
}

async function leadOwnsPanel(request: APIRequestContext): Promise<boolean> {
  const panels = await fetchPanels(request, await getAuthToken(request));
  return panels.some((p) => p.assignee?.toLowerCase() === MAUI_ACCOUNTS.qualityLead.email);
}

test.describe("Header search finds the patient typed", () => {
  test("two letters match names only, never every patient by their shared role or id prefix", async ({ page }) => {
    await page.goto("/worklist");
    await waitForDataRows(page);
    await searchBox(page).fill("pa");
    // The status line settles once the debounced read has answered.
    await expect(page.getByRole("status").filter({ hasText: /patients? found/i })).toHaveText(/patients? found/i, { timeout: 15_000 });
    // Every Maui patient's role is "Patient" and every id starts "pat-", so the old search listed
    // arbitrary patients here. Whatever is listed now must carry the letters in its NAME.
    const shown = await searchResults(page).evaluateAll((buttons) =>
      buttons.map((b) => (b.querySelector("p")?.textContent ?? "").toLowerCase()),
    );
    for (const name of shown) expect(name, `"${name}" was listed for "pa"`).toContain("pa");
  });

  test("an id typed in full ranks first, and Enter opens that patient", async ({ page }) => {
    const externalId = await firstWorklistPatient(page);
    await searchBox(page).fill(externalId);
    await expect(searchResults(page).first()).toContainText(externalId, { timeout: 15_000 });
    await searchBox(page).press("Enter");
    await expect(page).toHaveURL(new RegExp(`/patients/${externalId}$`), { timeout: 15_000 });
    await expectNoErrorPage(page);
  });
});

test.describe("The patient page leads with the work", () => {
  test("Open Cases first with a button per gap, evidence folded, and the button opens a readable case", async ({ page }) => {
    const externalId = await firstWorklistPatient(page);
    await page.goto(`/patients/${encodeURIComponent(externalId)}`);
    const openCases = page.getByTestId("open-cases");
    await expect(openCases).toBeVisible({ timeout: 30_000 });
    await expectNoErrorPage(page);

    // The work above the reference material: Open Cases sits above Measure Details on the page.
    const details = page.getByRole("heading", { name: "Measure Details" });
    const [casesBox, detailsBox] = [await openCases.boundingBox(), await details.boundingBox()];
    expect(casesBox && detailsBox && casesBox.y < detailsBox.y, "Open Cases is above Measure Details").toBe(true);

    // Folded for a case-managing seat on the pilot profile, still on the page for whoever opens it.
    await expect(page.getByTestId("evidence-disclosure")).not.toHaveAttribute("open", /.*/);
    await expect(page.getByTestId("simulation-disclosure")).not.toHaveAttribute("open", /.*/);

    // The patient came from the work list, so they have at least one open gap, and each has its button.
    const buttons = openCases.getByRole("link", { name: /^Open case:/ });
    await expect(buttons.first()).toBeVisible();
    await expect(buttons.first()).toHaveAttribute("href", /^\/cases\/[^/]+$/);
    await buttons.first().click();
    await expect(page).toHaveURL(/\/cases\/[^/]+$/, { timeout: 15_000 });

    // The timeline reads in words: no stored payload and no Details for staff, and no entry titled in
    // the ledger's SCREAMING_CASE.
    await expect(page.getByText("Audit timeline")).toBeVisible({ timeout: 30_000 });
    const history = page.getByRole("button", { name: /show history/i });
    if (await history.isVisible()) await history.click();
    const timeline = page.getByText("Audit timeline").locator("xpath=../..");
    await expect(timeline.locator("pre")).toHaveCount(0);
    await expect(timeline.getByTestId("timeline-details")).toHaveCount(0);
    const titles = await timeline.locator("p.font-semibold").allInnerTexts();
    expect(titles.length, "the timeline has at least one entry").toBeGreaterThan(0);
    for (const title of titles) expect(title, "an entry title in words").not.toMatch(/[A-Z]+_[A-Z]+/);
    await expectNoErrorPage(page);
  });
});

test.describe("Scorecard: one provider, and the view in the URL", () => {
  test("opens on My providers only for a panel owner, and a chosen provider survives a reload", async ({ page, request }) => {
    const owns = await leadOwnsPanel(request);
    await page.goto("/scorecard");
    await expect(page.getByRole("heading", { name: /Quality scorecard/i })).toBeVisible({ timeout: 20_000 });
    const picker = page.getByRole("combobox", { name: "Provider" }).filter({ visible: true }).first();
    await expect(picker).toBeVisible({ timeout: 30_000 });
    if (owns) await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe("me");
    else expect(new URL(page.url()).searchParams.get("panel"), "no panel is chosen for someone who owns none").toBeNull();

    await picker.click();
    const providers = page.getByRole("option").filter({ hasText: " — " });
    test.skip((await providers.count()) === 0, "this stack's scorecard has no provider rows");
    const label = (await providers.first().innerText()).trim();
    const name = label.split(" — ")[0];
    await providers.first().click();

    await expect.poll(() => new URL(page.url()).searchParams.get("provider")).not.toBeNull();
    const table = page.getByTestId("scorecard-table");
    await expect(table).toContainText(name);

    // A link to this view opens the same view: the provider is still chosen after a reload.
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Provider" }).filter({ visible: true }).first()).toHaveText(label, { timeout: 30_000 });
    await expect(page.getByTestId("scorecard-table")).toContainText(name);
    await expectNoErrorPage(page);
  });
});

test.describe("Work list: select every patient matching, not just the page", () => {
  test("once the page is ticked, the bar offers every match, or says why not above 500", async ({ page }) => {
    await page.goto("/worklist");
    await waitForDataRows(page);
    const onPage = await page.locator("tbody tr a[href^='/patients/']").count();

    await page.getByRole("checkbox", { name: /select all patients on this page/i }).filter({ visible: true }).first().check();
    const offer = page.getByRole("button", { name: /^Select all [\d,]+ matching patients$/ });
    const stated = page.getByText(/^[\d,]+ patients? selected$/);
    await expect(stated).toBeVisible();
    // A list that fits on one page has nothing more to offer.
    if (!(await offer.isVisible())) {
      test.skip(true, `the default view fits on one page here (${onPage} patients)`);
    }
    const total = Number((await offer.innerText()).match(/([\d,]+)/)![1].replace(/,/g, ""));
    expect(total).toBeGreaterThan(onPage);

    if (total > 500) {
      // The list endpoint answers 500 patients at most, so the offer is refused with its reason rather
      // than quietly taking the first 500 as "all".
      await expect(offer).toBeDisabled();
      await expect(page.getByText(/More than 500 patients match/)).toBeVisible();
    } else {
      await offer.click();
      await expect(page.getByText(new RegExp(`^All ${total.toLocaleString("en-US")} matching patients selected \\(`))).toBeVisible({ timeout: 30_000 });
    }
    await page.getByRole("button", { name: "Clear selection" }).click();
    await expect(stated).toHaveCount(0);
    await expectNoErrorPage(page);
  });
});
