import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  API_BASE,
  type PanelRow,
  AS_QUALITY_LEAD_PANELS,
  MAUI_ACCOUNTS,
  WRITES_SKIP_REASON,
  expectNoErrorPage,
  fetchPanels,
  getAuthToken,
  loginAs,
  waitForDataRows,
  writesAllowed,
} from "./helpers";

/**
 * The work list's WRITES: mapping a provider panel (which moves that panel's open gaps) and assigning
 * a patient's whole set of gaps in one request. Issue #554, ADR-080.
 *
 * Separate from `worklist.spec.ts` for two reasons, both learned rather than assumed.
 *
 * It runs in the `maui-writes` project, which `dependencies: ["maui"]` schedules after every read-only
 * spec has finished. A panel mapping moves several hundred cases; with four workers that write was in
 * flight while other specs read the same list, and the first parallel CI run came back "4 flaky,
 * 22 passed" — green only because retries hid it.
 *
 * And every test here refuses to run unless the target is a local stack or the operator asked for
 * writes by name. On 2026-09-12 this suite was pointed at the deployed pilot sandbox: the mapping
 * moved 339 open cases and the restore, reading one page of 50, put back 50 — leaving 289 cases
 * assigned to a staff account for about ten minutes on a stack the pilot group signs into.
 *
 * Everything written here is restored, each block restores each case to the assignee it actually had
 * (never blanket-unassigns), and the file-level hook at the bottom asks the SERVER whether the stack
 * is back rather than trusting the restore loop — the two came apart once already.
 */

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  test.skip(!writesAllowed(), WRITES_SKIP_REASON);
});

const QUALITY_STAFF = MAUI_ACCOUNTS.qualityStaff.email;

/** The work-list row's gap badge: the count and the highest priority on it, e.g. "3 High". */
const GAP_BADGE = /^\d+ (High|Medium|Low)$/;

/**
 * How many cases `openCasesFor` asks for at a time — deliberately SMALL.
 *
 * The paging loop below is the code that failed on 09-12, reading 50 of 339 cases and restoring 50 of
 * them. A page size of 500 would exercise it only where a panel exceeds 500 cases, and the write guard
 * confines this file to a local stack whose whole corpus is 48 patients — so the loop that prevents a
 * partial restore would have had no coverage at any size that makes paging happen. Twenty-five pages
 * a typical panel on either stack, which costs a handful of requests and means the loop, its
 * exhaustion check and the `X-Total-Count` assertion all actually run.
 */
const CASE_PAGE = 25;

/** A case and the assignee it held before this suite touched it. */
interface PriorOwner {
  caseId: string;
  assignee: string | null;
}

/**
 * Every ACTIVE case for a provider's patients, with its current owner, paged and CHECKED against the
 * count the server reports.
 *
 * The check is the point, and it earned its place. `/api/cases` pages on `limit`/`offset` and IGNORES
 * `pageSize`/`page`, so the first version of this helper asked for `pageSize=200&page=N`, was handed
 * the default first 50 every time, and reported a panel of 339 open gaps as a panel of 50. The test
 * then failed on the toast — but the cleanup had already been handed that same short list, so the
 * restore put 50 cases back and left 289 assigned on a shared sandbox. A cleanup that silently
 * restores a subset is worse than one that fails, so an incomplete read is an error here rather than
 * a smaller number.
 */
async function openCasesFor(request: APIRequestContext, token: string, providerId: string): Promise<PriorOwner[]> {
  const headers = { Authorization: `Bearer ${token}` };
  const query = `providerId=${encodeURIComponent(providerId)}&status=open&limit=${CASE_PAGE}`;
  const owners = new Map<string, string | null>();
  let total = 0;
  for (let offset = 0; offset < 50_000; offset += CASE_PAGE) {
    const res = await request.get(`${API_BASE}/api/cases?${query}&offset=${offset}`, { headers });
    expect(res.status()).toBe(200);
    if (offset === 0) total = Number(res.headers()["x-total-count"] ?? 0);
    const batch = (await res.json()) as Array<{ caseId: string; assignee?: string | null }>;
    // `assignee` is always present on a case summary (`case-read-models.ts` `toCaseSummary` sets it,
    // null when nobody owns the case). Asserted rather than assumed with `?? null`, because a missing
    // key read as "unassigned" would make the restore CLEAR a case an operator owns.
    for (const c of batch) {
      expect(Object.keys(c), `case ${c.caseId} reports its assignee`).toContain("assignee");
      owners.set(c.caseId, c.assignee ?? null);
    }
    if (batch.length === 0 || owners.size >= total) break;
  }
  expect(owners.size, "every open case on the panel was read, not just the first page").toBe(total);
  return [...owners].map(([caseId, assignee]) => ({ caseId, assignee }));
}

/** How many open cases an account currently owns, straight from the server. */
async function openCasesOwnedBy(request: APIRequestContext, token: string, assignee: string): Promise<number> {
  const res = await request.get(
    `${API_BASE}/api/cases?status=open&assignee=${encodeURIComponent(assignee)}&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(res.status()).toBe(200);
  return Number(res.headers()["x-total-count"] ?? 0);
}

/**
 * Put each case back on the person who had it — grouped by prior owner, so a case an operator had
 * already assigned is not silently cleared by a restore that only knows how to unassign.
 */
async function restoreOwners(request: APIRequestContext, token: string, prior: readonly PriorOwner[]): Promise<void> {
  // An empty assignee is the unassign path, not a validation error: `routes/worklist.ts` coerces a
  // null/undefined/blank `assignee` to `null` before it reaches `resolveAssignable`, so only a
  // NON-empty unknown address is a 400. Checked in the route rather than assumed, because a restore
  // that 400s runs after the write and reports success.
  const headers = { Authorization: `Bearer ${token}` };
  const byOwner = new Map<string, string[]>();
  for (const p of prior) byOwner.set(p.assignee ?? "", [...(byOwner.get(p.assignee ?? "") ?? []), p.caseId]);
  for (const [assignee, caseIds] of byOwner) {
    for (let i = 0; i < caseIds.length; i += 500) {
      const res = await request.post(`${API_BASE}/api/cases/bulk-assign`, {
        headers,
        data: { assignee, caseIds: caseIds.slice(i, i + 500) },
      });
      if (res.status() !== 200) throw new Error(`restore bulk-assign failed: ${res.status()} ${await res.text()}`);
    }
  }
}

/**
 * Every case is back on the person who had it — compared case by case, not counted.
 *
 * A count is the weaker claim and it is the one that passes while the stack is wrong: a restore that
 * put case X on the wrong prior owner, or moved one case out and another in, keeps the total. The
 * prior owners are already in hand, so comparing them costs one read and says something true.
 */
async function expectRestored(
  request: APIRequestContext,
  token: string,
  prior: readonly PriorOwner[],
  current: ReadonlyMap<string, string | null>,
): Promise<void> {
  const wrong = prior
    .filter((p) => current.has(p.caseId) && current.get(p.caseId) !== p.assignee)
    .map((p) => `${p.caseId}: ${current.get(p.caseId) ?? "unassigned"} (was ${p.assignee ?? "unassigned"})`);
  if (wrong.length > 0) {
    throw new Error(`${wrong.length} case(s) were not restored to their previous owner — ${wrong.slice(0, 5).join("; ")}`);
  }
}

/** The current owner of each named case, one request per case — used on the small sets only. */
async function ownersOf(
  request: APIRequestContext,
  token: string,
  caseIds: readonly string[],
): Promise<Map<string, string | null>> {
  const owners = new Map<string, string | null>();
  for (const caseId of caseIds) {
    const res = await request.get(`${API_BASE}/api/cases/${caseId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status() !== 200) continue;
    const detail = (await res.json()) as { assignee?: string | null };
    owners.set(caseId, detail.assignee ?? null);
  }
  return owners;
}

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

/**
 * What the staff account owned before this file ran. Asserted again at the end: "the restore loop
 * finished" and "the stack is back" are different claims, and only the server can make the second.
 */
let ownedAtStart: number | null = null;

test.beforeAll(async ({ playwright }) => {
  if (process.env.PLAYWRIGHT_PROFILE !== "maui" || !writesAllowed()) return;
  const ctx = await playwright.request.newContext();
  try {
    ownedAtStart = await openCasesOwnedBy(ctx, await getAuthToken(ctx), QUALITY_STAFF);
  } finally {
    await ctx.dispose();
  }
});

/**
 * #554's second ask: one patient, every gap they have, one request. The control counts GAPS while the
 * selection counts PATIENTS, and the toast reports what MOVED rather than what was asked for.
 */
test.describe("Maui work list — assigning a patient's whole set of gaps", () => {
  test.describe.configure({ mode: "serial" });
  test.use(AS_QUALITY_LEAD_PANELS);

  let token = "";
  let touched: PriorOwner[] = [];

  test("selecting one patient assigns every open gap they have, in one request", async ({ page, request }) => {
    token = await getAuthToken(request);

    await openWorklist(page);
    await waitForDataRows(page);

    // A patient with more than one gap is the whole point: with one gap this proves nothing that the
    // case list did not already do.
    const rows = page.locator("tbody tr");
    const count = await rows.count();
    let row = null;
    let gapCount = 0;
    for (let i = 0; i < count; i++) {
      // The gap badge by its own text ("3 High"), never by column index: the insurance column only
      // renders on a roster that records a payer, so the index moves between deployments.
      const badge = rows.nth(i).getByText(GAP_BADGE).first();
      if ((await badge.count()) === 0) continue;
      const n = Number(((await badge.innerText()).match(/^(\d+)/) ?? [])[1] ?? 0);
      if (n >= 2) {
        row = rows.nth(i);
        gapCount = n;
        break;
      }
    }
    test.skip(row === null, "no patient on the first page has more than one open gap");

    // Identified by the id in the row's own link. The displayed NAME is not unique — the corpus only
    // makes (name, date of birth) unique, so at 20,000 patients two people can share one — and this
    // row's gaps become the restore list: a collision would assign patient A's gaps and then restore
    // patient B's, leaving A's on the staff account with every assertion still green.
    const name = (await row!.locator("a[href^='/employees/']").first().innerText()).trim();
    const profileHref = (await row!.locator("a[href^='/employees/']").first().getAttribute("href")) ?? "";
    const employeeId = decodeURIComponent(profileHref.replace("/employees/", ""));
    expect(employeeId, "the row links the patient it renders").not.toBe("");
    const listRes = await request.get(
      `${API_BASE}/api/worklist/patients?status=open&limit=25&search=${encodeURIComponent(employeeId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(listRes.status()).toBe(200);
    const subject = ((await listRes.json()) as Array<{
      employeeId: string;
      gapCount: number;
      openGaps: Array<{ caseId: string; assignee: string | null }>;
    }>).find((r) => r.employeeId === employeeId);
    expect(subject, `the server knows ${employeeId}`).toBeTruthy();
    expect(subject!.gapCount, "the page's badge and the server's gap count agree").toBe(gapCount);
    touched = subject!.openGaps.map((g) => ({ caseId: g.caseId, assignee: g.assignee ?? null }));

    await row!.getByRole("checkbox", { name: `Select ${name}` }).check();
    await chooseFrom(page, "Assignee for selected", QUALITY_STAFF);

    // The button counts GAPS, not the one patient selected — which is the difference between this work
    // list and the case list it replaced.
    const assign = page.getByRole("button", { name: new RegExp(`^Assign ${gapCount} open gaps?$`) });
    await expect(assign, "the control names the gaps it is about to move").toBeVisible();
    await assign.click();

    await expect(page.getByText(new RegExp(`${gapCount} gaps? assigned to ${QUALITY_STAFF}`))).toBeVisible({
      timeout: 60_000,
    });
  });

  test("every one of that patient's gaps moved, not just the one that was clicked", async ({ request }) => {
    test.skip(touched.length === 0, "the assign step skipped");
    const headers = { Authorization: `Bearer ${token}` };
    for (const { caseId } of touched) {
      const res = await request.get(`${API_BASE}/api/cases/${caseId}`, { headers });
      expect(res.status(), `GET /api/cases/${caseId}`).toBe(200);
      const detail = (await res.json()) as { assignee?: string | null };
      expect(detail.assignee, `case ${caseId} belongs to the chosen assignee`).toBe(QUALITY_STAFF);
    }
  });

  test.afterAll(async ({ playwright }) => {
    if (!token || touched.length === 0) return;
    const ctx = await playwright.request.newContext();
    try {
      await restoreOwners(ctx, token, touched);
      await expectRestored(ctx, token, touched, await ownersOf(ctx, token, touched.map((t) => t.caseId)));
    } finally {
      await ctx.dispose();
    }
  });
});

/**
 * Mapping a panel moves its open gaps. Serial because each step depends on the previous one's state,
 * and because two workers mapping the same provider would each see the other's backfill.
 */
test.describe("Maui panels — mapping a panel moves its open gaps", () => {
  test.describe.configure({ mode: "serial" });
  test.use(AS_QUALITY_LEAD_PANELS);

  let token = "";
  let provider: PanelRow | undefined;
  let moved: PriorOwner[] = [];
  /** What the API said it actually moved — the panel's open cases minus any an operator owns. */
  let backfilled = 0;

  test("a supervisor maps an un-owned panel and is told what moved", async ({ page, request }) => {
    token = await getAuthToken(request);
    const panels = await fetchPanels(request, token);
    const candidates = panels.filter((p) => !p.assignee).sort((a, b) => a.patients - b.patients);
    test.skip(candidates.length === 0, "every panel already has an owner on this stack");
    provider = candidates[0]!;

    moved = await openCasesFor(request, token, provider.providerId);

    await openWorklist(page, "?tab=panels");
    const label = `Worked by, ${provider.providerName}`;
    await expect(selectTrigger(page, label)).toBeVisible({ timeout: 30_000 });
    await chooseFrom(page, label, QUALITY_STAFF);

    // The toast reports what MOVED, not what was asked for: "Saved" over a mapping that quietly
    // reassigned a few hundred open cases tells the operator nothing about the part that matters.
    // Captured in ONE poll, not asserted-then-re-read: a success toast dismisses itself after five
    // seconds, so finding it and then asking for its text again can land after it has detached.
    const toastText = new RegExp(`${provider.providerName} → ${QUALITY_STAFF}`);
    let toast = "";
    await expect
      .poll(
        async () => {
          const found = page.getByText(toastText).first();
          toast = (await found.count()) > 0 ? await found.innerText() : "";
          return toast;
        },
        { timeout: 60_000 },
      )
      .not.toBe("");

    if (moved.length > 0) {
      // An UPPER bound, not equality: ADR-080 d3 exempts an OPERATOR-owned case from the backfill, and
      // the describe above this one leaves OPERATOR-sourced cases behind, so a panel holding one of
      // them moves fewer cases than it has. Equality here would report that rule working as the
      // backfill being broken.
      const reported = Number((toast.match(/(\d[\d,]*) open gap/) ?? [])[1]?.replace(/,/g, "") ?? NaN);
      expect(Number.isFinite(reported), `the toast names what moved: "${toast}"`).toBe(true);
      expect(reported, "the backfill cannot move more cases than the panel has").toBeLessThanOrEqual(moved.length);
      expect(reported, "a panel with open gaps moves some of them").toBeGreaterThan(0);
      backfilled = reported;
    } else {
      expect(toast).toContain("no open gaps to move");
      backfilled = 0;
    }
  });

  test("the mapping and the backfill are what the next read sees", async ({ request }) => {
    // Serial mode skips what FOLLOWS A FAILURE, not what follows a skip — so when the test above
    // legitimately skips (every panel already owned), these three would run with no provider and
    // throw on `provider!`, turning a stack this suite has nothing to say about into a red file.
    test.skip(provider === undefined, "the mapping step skipped");
    const row = (await fetchPanels(request, token)).find((p) => p.providerId === provider!.providerId);
    expect(row?.assignee, "the mapping survives the round trip").toBe(QUALITY_STAFF);

    const res = await request.get(
      `${API_BASE}/api/cases?providerId=${encodeURIComponent(provider!.providerId)}&status=open&assignee=${encodeURIComponent(QUALITY_STAFF)}&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status()).toBe(200);
    // What the toast claimed is what the next read sees — the toast is the operator's only evidence,
    // so a number it reports that the data does not hold is the defect this asserts against.
    expect(Number(res.headers()["x-total-count"]), "the gaps the toast reported are the gaps that moved").toBe(
      backfilled,
    );
  });

  test("the staffer who now owns the panel opens on it by default", async ({ browser }) => {
    test.skip(provider === undefined, "the mapping step skipped");
    // `storageState: undefined` EXPLICITLY. A context made from the `browser` fixture inherits the
    // options in `use`, including this describe's signed-in supervisor state — so without this the
    // sign-in below lands in a session that is already the supervisor, and the test reports the
    // supervisor's default view as the staffer's. It failed that way once, against a page that was
    // behaving correctly.
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    try {
      await loginAs(page, QUALITY_STAFF);
      await openWorklist(page);

      // ADR-080 d5, the half only a browser can prove: no `panel` parameter in the URL, and the page
      // decides from the mappings that this viewer owns one.
      await expect(selectTrigger(page, "View")).toHaveText(/My panel/, { timeout: 30_000 });
      await expect(page.getByText(new RegExp(`My panel: .*${provider!.providerName}`))).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  test("un-mapping the panel leaves the open gaps with their owner", async ({ page, request }) => {
    test.skip(provider === undefined, "the mapping step skipped");
    await openWorklist(page, "?tab=panels");
    const row = page.locator("tbody tr").filter({ hasText: provider!.providerName }).first();
    await row.getByRole("button", { name: "Unassign" }).click();

    // ADR-080 d4, said out loud because it is the surprising half.
    await expect(page.getByText(/Open gaps keep their current owner/i)).toBeVisible({ timeout: 60_000 });

    const panels = await fetchPanels(request, token);
    expect(panels.find((p) => p.providerId === provider!.providerId)?.assignee).toBeNull();

    if (backfilled > 0) {
      const res = await request.get(
        `${API_BASE}/api/cases?providerId=${encodeURIComponent(provider!.providerId)}&status=open&assignee=${encodeURIComponent(QUALITY_STAFF)}&limit=1`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(Number(res.headers()["x-total-count"]), "un-mapping is about FUTURE work, not tonight's").toBe(
        backfilled,
      );
    }
  });

  test.afterAll(async ({ playwright }) => {
    if (!token || !provider) return;
    const ctx = await playwright.request.newContext();
    try {
      const removed = await ctx.delete(`${API_BASE}/api/panels/${provider.providerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // A mapping left behind is INVISIBLE to the case-count guard below — un-mapping deliberately
      // moves no cases — so a failed or skipped DELETE would leave the panel owned by a staff account
      // and nothing would say so. 404 is fine: the un-map test may already have removed it.
      if (![200, 204, 404].includes(removed.status())) {
        throw new Error(`un-mapping ${provider.providerId} failed: ${removed.status()} ${await removed.text()}`);
      }
      const stillMapped = (await fetchPanels(ctx, token)).find((p) => p.providerId === provider!.providerId);
      expect(stillMapped?.assignee ?? null, "the panel this file mapped is un-mapped again").toBeNull();

      await restoreOwners(ctx, token, moved);
      // The panel's cases re-read the same way they were snapshotted, and compared one by one.
      const now = new Map((await openCasesFor(ctx, token, provider.providerId)).map((c) => [c.caseId, c.assignee]));
      await expectRestored(ctx, token, moved, now);
    } finally {
      await ctx.dispose();
    }
  });
});

/**
 * The one claim the restore loops cannot make about themselves. Each block puts back what it took;
 * this asks the server whether the account is where it started, and fails loudly if it is not, so a
 * partial restore is never mistaken for a clean exit.
 */
test.afterAll(async ({ playwright }) => {
  if (ownedAtStart === null) return;
  const ctx = await playwright.request.newContext();
  try {
    const owned = await openCasesOwnedBy(ctx, await getAuthToken(ctx), QUALITY_STAFF);
    if (owned !== ownedAtStart) {
      throw new Error(
        `${QUALITY_STAFF} owns ${owned} open cases and owned ${ownedAtStart} before this file ran — the stack was not restored`,
      );
    }
  } finally {
    await ctx.dispose();
  }
});
