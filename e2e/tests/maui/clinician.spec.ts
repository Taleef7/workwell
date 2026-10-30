import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  API_BASE,
  AS_CLINICIAN,
  MAUI_ACCOUNTS,
  MAUI_PASSWORD,
  expectNoErrorPage,
  getAuthToken,
  rosterTotal,
  statedRosterTotal,
  waitForDataRows,
} from "./helpers";

/**
 * The clinician seat's "just mine" (#870) — READ-ONLY.
 *
 * The seat is linked to one provider on the account (`backend-ts/src/auth/demo-users.ts`), and sees the
 * practice everywhere it did before, plus a way to its own patients: a toggle on Programs that opens its
 * scorecard (its own row beside the practice total) and a button on the roster that narrows to its panel.
 * The counts are pinned by the backend's route tests; this walks the screens on a live stack and asserts
 * rows, not values, since CI's corpus gives the provider two patients and the sandbox about five hundred.
 */
test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  // The scorecard reads the whole practice's year (about 15 s warm on the 20,000-patient sandbox, more
  // cold), and each test here waits on it or on a fresh sign-in after other waits.
  test.setTimeout(180_000);
});

test.use(AS_CLINICIAN);

// The provider the seat is linked to, as `demo-users.ts` writes it.
const LINKED_PROVIDER = "maui-prov-011";

async function clinicianToken(request: APIRequestContext): Promise<string> {
  // Its own sign-in, so its own refresh-token family: the browser session above is never rotated by it.
  const res = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: MAUI_ACCOUNTS.clinician.email, password: MAUI_PASSWORD },
    timeout: 120_000,
  });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

test.describe("Maui clinician seat", () => {
  test("Programs offers the whole practice or my patients, and my patients is the seat's own scorecard", async ({ page }) => {
    await page.goto("/programs");
    const toggle = page.getByTestId("programs-mine-toggle");
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await expect(toggle.getByRole("button", { name: "Whole practice" })).toHaveAttribute("aria-pressed", "true");
    // The seat's provider on its user card, and the scorecard in its nav under its own name.
    await expect(page.getByText(/Viewer · Dr\. /).first()).toBeVisible();
    await expect(page.getByText("My scorecard", { exact: true }).first()).toBeVisible();

    await toggle.getByRole("link", { name: /^My patients/ }).click();
    await expect(page).toHaveURL(/\/scorecard/);
    await expect(page.getByRole("heading", { name: /^Your patients — / })).toBeVisible({ timeout: 20_000 });

    // Global setup guarantees a completed population run of this year, so the card has rows. The live
    // load takes seconds on the sandbox; the page says so while it waits.
    const table = page.getByTestId("scorecard-table");
    await expect(table).toBeVisible({ timeout: 60_000 });
    await expect(table.getByTestId("scorecard-row-mine")).toContainText("(you)");
    await expect(table.getByTestId("scorecard-row-total")).toContainText("Practice total");
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(table.getByTestId("scorecard-row-subtotal")).toHaveCount(0);
    // Open gaps are a count here, never a way into the work list, which is not the seat's.
    await expect(table.locator("a[href^='/worklist']")).toHaveCount(0);
    await expectNoErrorPage(page);

    // And back: the other half of the toggle is the practice.
    await page.getByRole("group", { name: "Which patients" }).getByRole("link", { name: "Whole practice" }).click();
    await expect(page).toHaveURL(/\/programs/);
  });

  test("the roster's My patients narrows to the seat's panel, and nothing more", async ({ page, request }) => {
    await page.goto("/compliance");
    await waitForDataRows(page);
    const mine = page.getByTestId("roster-my-patients");
    await expect(mine).toHaveAttribute("aria-pressed", "false");
    await mine.click();
    await expect(page).toHaveURL(new RegExp(`providerId=${LINKED_PROVIDER}`));
    await expect(mine).toHaveAttribute("aria-pressed", "true");
    await waitForDataRows(page);

    // The same total the roster reports for that provider, and fewer than the practice's.
    const token = await getAuthToken(request);
    const theirs = await rosterTotal(request, token, `providerId=${LINKED_PROVIDER}`);
    await expect.poll(() => statedRosterTotal(page), { timeout: 20_000 }).toBe(theirs);
    expect(theirs).toBeLessThan(await rosterTotal(request, token));
    await expectNoErrorPage(page);
  });

  test("the scorecard answers the seat with its own row and no colleague's, and keeps its sub-paths closed", async ({ request }) => {
    const headers = { authorization: `Bearer ${await clinicianToken(request)}` };
    const mine = await request.get(`${API_BASE}/api/providers/mine`, { headers });
    expect(mine.status()).toBe(200);
    expect(((await mine.json()) as { provider: { id: string } | null }).provider?.id).toBe(LINKED_PROVIDER);

    const card = await request.get(`${API_BASE}/api/scorecard`, { headers, timeout: 120_000 });
    expect(card.status()).toBe(200);
    const body = (await card.json()) as { locations: unknown[]; other: unknown; scope?: { providerId: string } };
    expect(body.scope?.providerId).toBe(LINKED_PROVIDER);
    expect(body.locations).toEqual([]);
    expect(body.other).toBeNull();

    const sub = await request.get(`${API_BASE}/api/scorecard/export`, { headers });
    expect(sub.status()).toBe(403);
  });
});
