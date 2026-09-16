import { test, expect } from "@playwright/test";
import { API_BASE, AS_QUALITY_LEAD_ROSTER, expectNoErrorPage, getAuthToken } from "./helpers";

/**
 * The attributed-lists screen (MM-2 PR 3, ADR-082) — READ-ONLY.
 *
 * Importing a list is a WRITE and belongs in `maui-writes`; this project runs first and must be
 * harmless when the thing it tests is broken, so every assertion here is about a surface that exists
 * whether or not any list has been imported. The negative-authorization checks name a list id that
 * cannot exist, for the same reason.
 *
 * The one thing worth an e2e rather than a unit test: this route's READS are CM/ADMIN, unlike every
 * other directory surface on this deployment. A regression that dropped it to the AUTHENTICATED
 * catch-all would look entirely normal in a unit test of the page and would expose an ACO's
 * attribution to the read-only sandbox seat.
 */
test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.use(AS_QUALITY_LEAD_ROSTER);

/** A syntactically valid UUID that no import can have produced. */
const ABSENT_LIST = "9f1c2b3a-0000-4000-8000-0000000000ff";

test.describe("Maui attributed lists", () => {
  test("the page renders for a case-managing seat, with the import form and the lists table", async ({ page }) => {
    await page.goto("/lists");
    await expect(page.getByRole("heading", { name: /Attributed lists/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /Import a list/i })).toBeVisible();
    // The sandbox boundary is stated on the screen, not only in the refusal — somebody about to paste
    // a real attribution file should be told before they press the button, not after.
    await expect(page.getByText(/synthetic sandbox/i)).toBeVisible();
    await expectNoErrorPage(page);
  });

  test("an absent list is a 404 on every read of it, never an unfiltered answer", async ({ request }) => {
    // Names a list that cannot exist, so this test is harmless whatever the stack holds — and a
    // regression that dropped the `?listId=` resolution would answer 200 here with everybody in it.
    const token = await getAuthToken(request);
    const headers = { authorization: `Bearer ${token}` };
    for (const path of [
      `/api/subject-lists/${ABSENT_LIST}`,
      `/api/subject-lists/${ABSENT_LIST}/members`,
      `/api/subject-lists/${ABSENT_LIST}/report?measurementYear=2027`,
      `/api/worklist/patients?listId=${ABSENT_LIST}`,
      `/api/cases?listId=${ABSENT_LIST}&limit=1`,
    ]) {
      const res = await request.get(`${API_BASE}${path}`, { headers });
      expect(res.status(), `${path} must refuse an unknown list`).toBe(404);
    }
  });

  test("the report refuses to guess a measurement year", async ({ request }) => {
    // ADR-072: an officially routed run is scored over its calendar year, so a default would answer a
    // PY2027 question with PY2028's first nightly every January — and would look correct.
    const token = await getAuthToken(request);
    const res = await request.get(`${API_BASE}/api/subject-lists/${ABSENT_LIST}/report`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).parameter).toBe("measurementYear");
  });

  test("an anonymous caller is refused the list metadata, not just the members", async ({ request }) => {
    // Every method on /api/subject-lists is CM/ADMIN, metadata included — deliberately unlike panels,
    // whose reads are AUTHENTICATED. The list's mere existence says which patients an ACO claims.
    const res = await request.get(`${API_BASE}/api/subject-lists`);
    expect(res.status()).toBe(401);
  });
});
