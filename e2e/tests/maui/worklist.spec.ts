import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  API_BASE,
  AS_QUALITY_LEAD_WORKLIST,
  MAUI_ACCOUNTS,
  MAUI_PASSWORD,
  expectNoErrorPage,
  expectNoEmployeeWording,
  getAuthToken,
  waitForDataRows,
} from "./helpers";

/**
 * The patient-first work list and the provider panels behind it (MM-2 PR 1/PR 2, ADR-080) — issue #554.
 *
 * The panel rules are decided in pure functions and proven by unit tests. What only a browser against
 * a real stack can settle is everything around them: that the tab exists, that the route is reachable
 * through the dispatch chain and the auth gate in front of it, that the shape the page reads is the
 * shape the server sends, and that the view a staffer lands on is the one ADR-080 d5 describes.
 *
 * Counts are read from the stack rather than written down. CI carries 48 corpus patients and the
 * sandbox carries 20,000; a spec that only passes on one of them stops being run against the other.
 *
 * READ-ONLY. Everything that mutates lives in `worklist-writes.spec.ts`, which runs in the
 * `maui-writes` project after this one and refuses to run at all against a stack it may not write to.
 */

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

const QUALITY_STAFF = MAUI_ACCOUNTS.qualityStaff.email;

/** The fields `frontend/app/(dashboard)/worklist/page.tsx` re-declares and reads off every row. */
const WORKLIST_ROW_FIELDS = [
  "employeeId",
  "employeeName",
  "site",
  "providerId",
  "providerName",
  "payer",
  "payerName",
  "openGaps",
  "gapCount",
  "highestPriority",
  "owner",
  "assignees",
  "updatedAt",
] as const;

interface PanelRow {
  providerId: string;
  providerName: string;
  patients: number;
  assignee: string | null;
}

interface PayerOption {
  code: string;
  name: string;
  group: string;
  groupName: string;
  subjectCount: number;
}

interface WorklistGap {
  caseId: string;
  measureName: string;
  outcomeStatus: string;
}

interface WorklistRow {
  employeeId: string;
  employeeName: string;
  gapCount: number;
  openGaps: WorklistGap[];
}

async function fetchPanels(request: APIRequestContext, token: string): Promise<PanelRow[]> {
  const res = await request.get(`${API_BASE}/api/panels`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status(), "GET /api/panels").toBe(200);
  return (await res.json()) as PanelRow[];
}

async function fetchPayers(request: APIRequestContext, token: string): Promise<PayerOption[]> {
  const res = await request.get(`${API_BASE}/api/payers`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status(), "GET /api/payers").toBe(200);
  return (await res.json()) as PayerOption[];
}

/** One page of the work list plus the total the server reports for the whole query. */
async function fetchWorklist(
  request: APIRequestContext,
  token: string,
  query = "",
): Promise<{ rows: WorklistRow[]; total: number }> {
  const res = await request.get(`${API_BASE}/api/worklist/patients?status=open&limit=25${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status(), "GET /api/worklist/patients").toBe(200);
  const total = Number(res.headers()["x-total-count"] ?? NaN);
  expect(Number.isFinite(total), "the work list reports X-Total-Count").toBe(true);
  return { rows: (await res.json()) as WorklistRow[], total };
}

/**
 * The `@mieweb/ui` Select is a listbox behind a button, not a native `<select>`, so `selectOption` and
 * `toHaveValue` do not apply to it — the first version of this file used both and failed on a healthy
 * page. The chosen value is the trigger's own text.
 */
function selectTrigger(page: Page, label: string | RegExp) {
  return page.getByRole("combobox", { name: label }).filter({ visible: true }).first();
}

async function chooseFrom(page: Page, label: string | RegExp, option: string | RegExp) {
  await selectTrigger(page, label).click();
  await page.getByRole("option", { name: option }).filter({ visible: true }).first().click();
}

async function openWorklist(page: Page, query = "") {
  await page.goto(`/worklist${query}`);
  await expect(page.getByRole("tablist", { name: /work list views/i })).toBeVisible({ timeout: 30_000 });
  await expectNoErrorPage(page);
}

/** The count the page states in its own words, parsed rather than matched against a formatted number. */
async function statedTotal(page: Page): Promise<number> {
  const text = await page
    .getByText(/with open gaps/i)
    .first()
    .innerText();
  const match = text.match(/([\d,]+)\s+\S+\s+with open gaps/i);
  expect(match, `"${text}" states a total`).not.toBeNull();
  return Number(match![1].replace(/,/g, ""));
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("Maui work list — the default view", () => {
  test.use(AS_QUALITY_LEAD_WORKLIST);

  /**
   * Every test in this describe compares the page against the WHOLE practice, so every one of them
   * depends on the signed-in lead owning no panel — not just the first, which was the only one that
   * checked. If a write run left a panel mapped to that account, the page would default to "My panel"
   * and three tests would fail on a total mismatch that names nothing.
   */
  let leadOwnsPanel: boolean | null = null;
  test.beforeEach(async ({ request }) => {
    if (leadOwnsPanel === null) {
      const panels = await fetchPanels(request, await getAuthToken(request));
      leadOwnsPanel = panels.some((p) => p.assignee?.toLowerCase() === MAUI_ACCOUNTS.qualityLead.email);
    }
    test.skip(leadOwnsPanel, "these assertions are about a viewer who owns NO panel");
  });

  test("opens on the whole practice for a viewer who owns no panel", async ({ page }) => {
    await openWorklist(page);
    // WAIT before asserting: `ownsPanel` is undefined until the mappings arrive and the select reads
    // "Whole practice" the whole time, so an immediate assertion passes against a page that has not
    // yet decided — it cannot tell "unloaded" from "right".
    await waitForDataRows(page);

    // ADR-080 d5: serving the whole practice under a heading that says "My panel" would tell someone
    // that several thousand other people's patients are theirs, so an unmapped viewer gets the honest
    // heading rather than an empty list.
    await expect(selectTrigger(page, "View")).toHaveText(/Whole practice/);
    await expect(page.getByText(/My panel:/i)).toHaveCount(0);
    await expectNoEmployeeWording(page);
  });

  /**
   * #554's first ask, and the two halves of it a component test cannot reach: that the total counts
   * PEOPLE rather than gaps, and that the shape the page reads is the shape the server sends.
   * `WorklistPatientRow` is declared twice — once in `backend-ts/src/case/worklist-patients.ts` and
   * once in the page — and nothing fails today if the two drift apart.
   */
  test("one row per patient, every open gap on it, and the total counts patients", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const { rows, total } = await fetchWorklist(request, token);
    expect(rows.length, "the stack must have open gaps for this to mean anything").toBeGreaterThan(0);

    const keys = new Set(Object.keys(rows[0] as unknown as Record<string, unknown>));
    for (const field of WORKLIST_ROW_FIELDS) {
      expect(keys, `the page reads row.${field}; the API row must carry it (the type is declared twice)`).toContain(
        field,
      );
    }

    // PATIENTS, not gaps — the assertion this test is named for, and it needs a second number to be
    // one at all. `/api/cases` counts one row per patient-measure, which is what the work list
    // replaced; so wherever anybody is due for two things, the work list's total must be the smaller
    // of the two. Comparing the page's total with the work list's own total, as the first version did,
    // compares one server number against itself.
    const casesRes = await request.get(`${API_BASE}/api/cases?status=open&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(casesRes.status()).toBe(200);
    const gapTotal = Number(casesRes.headers()["x-total-count"] ?? NaN);
    expect(Number.isFinite(gapTotal)).toBe(true);
    if (rows.some((r) => r.gapCount > 1)) {
      expect(total, "the work list counts people; the case list counts gaps").toBeLessThan(gapTotal);
    } else {
      expect(total, "one gap each means the two counts agree").toBeLessThanOrEqual(gapTotal);
    }

    await openWorklist(page);
    await waitForDataRows(page);
    await expect
      .poll(() => statedTotal(page), { timeout: 30_000 })
      .toBe(total);

    // Take the patient the PAGE shows first and ask the server about that one, rather than assuming
    // the two orderings agree — an ordering assumption would fail as though it were a contract defect.
    //
    // Identified by the id in the row's own link, never by the displayed name: the corpus only makes
    // (name, date of birth) unique, so at 20,000 patients two people can share a name, and matching on
    // it would silently compare one person's row with another person's gaps.
    const firstRow = page
      .locator("tbody tr")
      .filter({ has: page.locator("a[href^='/employees/']") })
      .first();
    const profileHref = (await firstRow.locator("a[href^='/employees/']").first().getAttribute("href")) ?? "";
    const employeeId = decodeURIComponent(profileHref.replace("/employees/", ""));
    expect(employeeId, "the row links the patient it renders").not.toBe("");
    const { rows: matched } = await fetchWorklist(request, token, `&search=${encodeURIComponent(employeeId)}`);
    const subject = matched.find((r) => r.employeeId === employeeId);
    expect(subject, `the server knows the patient the page rendered first (${employeeId})`).toBeTruthy();

    // The badge states the gap count; the row links one chip per gap, capped at three until expanded.
    // Matched on the badge's own text ("3 High") rather than a column index, because the insurance
    // column only renders on a roster that records a payer and the index moves with it.
    await expect(
      firstRow.getByText(new RegExp(`^${subject!.gapCount} (High|Medium|Low)$`)),
      "the badge states this patient's gap count",
    ).toBeVisible();
    const chips = firstRow.locator("a[href^='/cases/']");
    await expect(chips).toHaveCount(Math.min(subject!.gapCount, 3));
    if (subject!.gapCount > 3) {
      await firstRow.getByRole("button", { name: new RegExp(`^\\+${subject!.gapCount - 3} more$`) }).click();
      await expect(chips).toHaveCount(subject!.gapCount);
    }
    // Every chip is one of that patient's own gaps, so the row is their whole workload and not a mix.
    const hrefs = await chips.evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""));
    const caseIds = new Set(subject!.openGaps.map((g) => g.caseId));
    for (const href of hrefs) {
      expect(caseIds, `chip ${href} must be one of this patient's open gaps`).toContain(
        decodeURIComponent(href.replace("/cases/", "")),
      );
    }
  });

  test("the Panels tab lists every provider and names the ones nobody owns", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const panels = await fetchPanels(request, token);
    const unmapped = panels.filter((p) => !p.assignee);

    await openWorklist(page, "?tab=panels");
    await expect(page.getByRole("tab", { name: "Panels" })).toHaveAttribute("aria-selected", "true");

    // Every provider, mapped or not. A screen listing only the covered panels would hide the gap on
    // the one page built to reveal it.
    await expect.poll(() => page.locator("tbody tr").count(), { timeout: 30_000 }).toBe(panels.length);

    if (unmapped.length > 0) {
      await expect(
        page.getByText(new RegExp(`${unmapped.length} panels? (has|have) no owner`)),
        "the count of un-owned panels is stated, not left to be counted by eye",
      ).toBeVisible();
      const firstCell = await page.locator("tbody tr").first().locator("td").first().innerText();
      expect(unmapped.map((p) => p.providerName), "unmapped panels sort first").toContain(firstCell.trim());
    }
  });

  /**
   * #554's fourth ask. A filtered list has to be a shareable link, which means the filter survives the
   * URL and a reload — and the number it lands on has to be the server's number for that panel, not
   * merely a smaller one. Page and page size are deliberately NOT in the URL (they are component
   * state), so nothing here expects them to survive.
   */
  test("the PCP filter narrows the list and round-trips through the URL", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const panels = await fetchPanels(request, token);
    const target = panels.find((p) => p.patients > 0) ?? panels[0]!;
    // Both totals from the SERVER. Reading the practice total off the page instead raced the loading
    // skeleton and compared the panel with a zero — which then read as "a panel is bigger than the
    // practice" rather than as "the page had not finished".
    const { total: practiceTotal } = await fetchWorklist(request, token);
    const { total: panelTotal } = await fetchWorklist(
      request,
      token,
      `&providerId=${encodeURIComponent(target.providerId)}`,
    );
    expect(panelTotal, "a panel is a subset of the practice").toBeLessThanOrEqual(practiceTotal);

    await openWorklist(page);
    await waitForDataRows(page);
    await expect.poll(() => statedTotal(page), { timeout: 30_000 }).toBe(practiceTotal);

    await chooseFrom(page, "PCP", new RegExp(escapeRegex(target.providerName)));
    await expect(page).toHaveURL(new RegExp(`providerId=${escapeRegex(encodeURIComponent(target.providerId))}`), {
      timeout: 30_000,
    });
    await expect.poll(() => statedTotal(page), { timeout: 30_000 }).toBe(panelTotal);

    // The link IS the state: a reload must land on the same filtered list, not on the whole practice.
    await page.reload();
    await expect(page.getByRole("tablist", { name: /work list views/i })).toBeVisible({ timeout: 30_000 });
    await expect(selectTrigger(page, "PCP")).toHaveText(new RegExp(escapeRegex(target.providerName)));
    await expect.poll(() => statedTotal(page), { timeout: 30_000 }).toBe(panelTotal);
    await expectNoErrorPage(page);
  });

  /**
   * #554's third ask, and the defect it guards is ADR-079's inverted: the Source of Payment Typology is
   * hierarchical, so a control offering "Medicare" that sent only code `1` hands back a smaller set
   * under a heading claiming to contain the rest. The group button must select every code in the
   * category the roster ACTUALLY has.
   */
  test("the insurance filter is a set, and 'All <category>' selects every code in it", async ({ page, request }) => {
    const token = await getAuthToken(request);
    const payers = await fetchPayers(request, token);
    const groups = new Map<string, PayerOption[]>();
    for (const p of payers) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
    const multi = [...groups.values()].find((codes) => codes.length > 1);
    test.skip(!multi, "this roster records no payer category with more than one code, so no group control renders");

    const groupName = multi![0].groupName;
    const codes = multi!.map((p) => p.code);
    const { total: before } = await fetchWorklist(request, token);

    await openWorklist(page);
    await waitForDataRows(page);
    await expect.poll(() => statedTotal(page), { timeout: 30_000 }).toBe(before);

    const groupButton = page.getByRole("button", { name: new RegExp(`^All ${escapeRegex(groupName)} \\(`) });
    await expect(groupButton).toBeVisible({ timeout: 30_000 });
    await groupButton.click();

    for (const code of codes) {
      await expect(page, `${groupName} must send code ${code}, not only the first`).toHaveURL(
        new RegExp(`payer=${escapeRegex(code)}(&|$)`),
        { timeout: 30_000 },
      );
    }
    await expect(page.getByRole("button", { name: `Clear ${groupName}` })).toBeVisible({ timeout: 30_000 });
    // The server's number for exactly this set of codes. "Not more than the practice" would also be
    // satisfied by a filter the server ignored entirely, which is the failure this test exists for.
    const { total: filtered } = await fetchWorklist(request, token, codes.map((c) => `&payer=${c}`).join(""));
    await expect.poll(() => statedTotal(page), { timeout: 30_000 }).toBe(filtered);
    expect(filtered, "a payer category is a subset of the practice").toBeLessThanOrEqual(before);

    // And it clears as a set too, or the operator is left holding a filter they cannot see or remove.
    await page.getByRole("button", { name: `Clear ${groupName}` }).click();
    await expect(page).not.toHaveURL(/payer=/, { timeout: 30_000 });
    await expectNoErrorPage(page);
  });
});

/**
 * The route's own gate.
 *
 * Every request here is refused, and each one is ALSO chosen so that it changes nothing if the refusal
 * stops happening. That is not belt and braces: a negative-authorization test sends the request it
 * expects to be denied, so on the day authorization regresses the write lands first and the assertion
 * fails second. Asserting "this is refused" and assuming "therefore nothing happened" makes the test's
 * premise the thing under test. The viewer's PUT names a provider that does not exist, and the one
 * request that must name a real provider — the unassignable-account 400 — is followed by a read that
 * proves the panel is where it was.
 */
test.describe("Maui panels — the route's auth gate", () => {
  test("a viewer may read the panels and may not change them; anonymous is refused", async ({ request }) => {
    const anon = await request.get(`${API_BASE}/api/panels`);
    expect(anon.status(), "no token").toBe(401);

    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: MAUI_ACCOUNTS.clinician.email, password: MAUI_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const headers = { Authorization: `Bearer ${(await login.json()).token as string}` };

    const read = await request.get(`${API_BASE}/api/panels`, { headers });
    expect(read.status(), "a viewer may see who works which panel").toBe(200);

    // Authorization is decided before the handler runs, so an unknown provider still answers 403 for a
    // viewer — and would answer 404 rather than mapping anything if the rule ever went missing.
    const write = await request.put(`${API_BASE}/api/panels/no-such-provider-e2e`, {
      headers,
      data: { assignee: QUALITY_STAFF },
    });
    expect(write.status(), "a viewer may not change a panel").toBe(403);
  });

  test("an unknown provider is a 404 and an unassignable account is a 400", async ({ request }) => {
    const token = await getAuthToken(request);
    const headers = { Authorization: `Bearer ${token}` };

    const missing = await request.put(`${API_BASE}/api/panels/no-such-provider`, {
      headers,
      data: { assignee: QUALITY_STAFF },
    });
    expect(missing.status(), "the resource is checked before the body").toBe(404);

    const panels = await fetchPanels(request, token);
    const target = panels[0]!;
    const bad = await request.put(`${API_BASE}/api/panels/${target.providerId}`, {
      headers,
      data: { assignee: "nobody@example.com" },
    });
    expect(bad.status()).toBe(400);
    // Naming the accounts that exist, not merely echoing the one that does not — `toContain("@")` was
    // satisfied by the rejected address appearing in the message.
    expect(
      JSON.stringify(await bad.json()),
      "the refusal names an account this deployment can actually assign to",
    ).toContain(QUALITY_STAFF);

    // The one request in this file aimed at a real provider, so the one that has to prove it left the
    // panel alone.
    const after = (await fetchPanels(request, token)).find((p) => p.providerId === target.providerId);
    expect(after?.assignee ?? null, "a refused mapping changes nothing").toBe(target.assignee ?? null);
  });
});
