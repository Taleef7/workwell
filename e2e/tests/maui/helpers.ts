import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BASE_URL, isLocalStack } from "../../base-url";

export const API_BASE = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:8080";
export { BASE_URL };
export const MAUI_PASSWORD = "Workwell123!";

/**
 * Whether this run may MUTATE the stack it is pointed at — DEFAULT DENY.
 *
 * On 2026-09-12 this suite was run against the deployed pilot sandbox and its panel test mapped a
 * provider, moving 339 open cases onto a staff account; the restore then read one page of 50 and put
 * back 50, leaving 289 cases assigned to somebody for about ten minutes on a stack the pilot group
 * signs into. `README-maui.md` had always said "only run this against a local stack" and nothing
 * enforced it, which is the shape this project keeps naming: a rule that reads as present and cannot
 * fire.
 *
 * **BOTH URLs have to be local, and that is the whole point of the check.** Every write this suite
 * performs — bulk assign, the panel PUT and DELETE, the manual run, every restore — is addressed to
 * `API_BASE`, which is set by its own environment variable. A guard that read only the browser's
 * `BASE_URL` would call `PLAYWRIGHT_BASE_URL=http://localhost:3000` with
 * `PLAYWRIGHT_API_BASE_URL=https://maui-api-ts.os.mieweb.org` a local run — a plausible pairing for
 * someone developing the frontend against the sandbox API — and let every one of those writes land on
 * the pilot. Caught in review; it was the same defect in the control written to prevent it.
 */
export function writesAllowed(): boolean {
  if (process.env.PLAYWRIGHT_ALLOW_WRITES === "1") return true;
  return isLocalStack(BASE_URL) && isLocalStack(API_BASE);
}

export const WRITES_SKIP_REASON =
  `writes are not allowed against ${BASE_URL} (api ${API_BASE}) — both must be local, or set PLAYWRIGHT_ALLOW_WRITES=1 to run them anyway. Read README-maui.md first: this suite restores what it touches, and the sandbox is shared with the pilot group`;

/**
 * Where `global-setup.ts` parks each role's signed-in browser state, so a spec adopts a session with
 * `test.use({ storageState: ... })` instead of driving the login form again. Gitignored: it holds a
 * live token for a demo account.
 */
const STATE_DIR = path.join(__dirname, "..", "..", ".auth");
export function storageStatePath(email: string, tag: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  return path.join(STATE_DIR, `${email.replace(/[^a-z0-9]+/gi, "-")}.${tag}.json`);
}

/**
 * The pilot profile hides the engineering surfaces from every role but ADMIN
 * (`frontend/lib/public-demo.ts`), so `/runs` and `/measures` render AccessDenied for the quality lead.
 * A spec about those pages adopts this state; one about the quality lead's own workflow must not.
 *
 * EMPTY off the maui profile, and that is load-bearing. The twh job runs `npx playwright test` with no
 * `--project`, which loads BOTH projects — and Playwright resolves the `page` fixture (and therefore
 * `storageState`) BEFORE the `beforeEach` that calls `test.skip`. Naming a file that global setup only
 * writes on the maui profile would fail these specs with `ENOENT` on the twh run instead of skipping
 * them, which is what they did before this existed.
 */
// Declared above the session table that reads them. MAUI_ACCOUNTS below carries the same addresses
// with their roles, but it is defined further down the file and a const cannot be read before its
// initializer has run (the first version of this table did exactly that and failed to load).
const QUALITY_LEAD_EMAIL = "quality-lead@maui.workwell.dev";
const ADMIN_EMAIL = "admin@maui.workwell.dev";

const MAUI = process.env.PLAYWRIGHT_PROFILE === "maui";
function session(email: string, tag: string) {
  return MAUI ? { storageState: storageStatePath(email, tag) } : {};
}

/**
 * One sign-in PER SPEC FILE, not one per role. Every context built from the same storage state shares
 * one refresh-token family, and `routes/auth.ts` revokes the whole family when an already-rotated
 * token is presented — so two parallel workers refreshing in the same window would sign each other
 * out, and the resulting AccessDenied failures would point nowhere near the cause. Distinct logins
 * mean distinct families. Still six sign-ins rather than the ~40 the per-test `loginAs` cost.
 */
export const AUTH_SESSIONS = [
  { email: QUALITY_LEAD_EMAIL, tag: "roster" },
  { email: QUALITY_LEAD_EMAIL, tag: "jelly-beans" },
  { email: QUALITY_LEAD_EMAIL, tag: "terminology" },
  { email: QUALITY_LEAD_EMAIL, tag: "readiness" },
  { email: QUALITY_LEAD_EMAIL, tag: "measure-detail" },
  { email: QUALITY_LEAD_EMAIL, tag: "worklist" },
  { email: QUALITY_LEAD_EMAIL, tag: "panels" },
  { email: ADMIN_EMAIL, tag: "runs" },
  { email: ADMIN_EMAIL, tag: "measures" },
  { email: ADMIN_EMAIL, tag: "terminology-admin" },
  { email: ADMIN_EMAIL, tag: "readiness-catalog" },
] as const;

export const AS_QUALITY_LEAD_ROSTER = session(QUALITY_LEAD_EMAIL, "roster");
export const AS_QUALITY_LEAD_CHIPS = session(QUALITY_LEAD_EMAIL, "jelly-beans");
export const AS_QUALITY_LEAD_TERMS = session(QUALITY_LEAD_EMAIL, "terminology");
export const AS_QUALITY_LEAD_READINESS = session(QUALITY_LEAD_EMAIL, "readiness");
export const AS_QUALITY_LEAD_MEASURE = session(QUALITY_LEAD_EMAIL, "measure-detail");
export const AS_QUALITY_LEAD_WORKLIST = session(QUALITY_LEAD_EMAIL, "worklist");
export const AS_QUALITY_LEAD_PANELS = session(QUALITY_LEAD_EMAIL, "panels");
export const AS_ADMIN_RUNS = session(ADMIN_EMAIL, "runs");
export const AS_ADMIN_MEASURES = session(ADMIN_EMAIL, "measures");
export const AS_ADMIN_TERMS = session(ADMIN_EMAIL, "terminology-admin");
export const AS_ADMIN_READINESS = session(ADMIN_EMAIL, "readiness-catalog");

/**
 * The ACO's whole computable set, which the Maui stack has ROUTED since ADR-078 — in CI too, since the
 * e2e job vendors the terminology sidecars with the VSAC credential. Each is a roster column, a
 * programs card and a set of status chips, so one list drives every spec that enumerates measures.
 * `mips` is the MIPS Quality Id the crosswalk renders beside the CMS id
 * (`backend-ts/src/measure/measure-identity.ts`).
 */
export const ROUTED_MEASURES = [
  { id: "cms122", cms: "CMS122", mips: "001", label: "Diabetes" },
  { id: "cms125", cms: "CMS125", mips: "112", label: "Breast Cancer Screening" },
  { id: "cms2", cms: "CMS2", mips: "134", label: "Depression" },
  { id: "cms130", cms: "CMS130", mips: "113", label: "Colorectal" },
  { id: "cms165", cms: "CMS165", mips: "236", label: "Blood Pressure" },
  { id: "cms137", cms: "CMS137", mips: "305", label: "Substance Use" },
] as const;

export const MAUI_ACCOUNTS = {
  qualityLead: { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
  qualityStaff: { email: "quality-staff@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
  clinician: { email: "clinician@maui.workwell.dev", role: "ROLE_VIEWER" },
  admin: { email: "admin@maui.workwell.dev", role: "ROLE_ADMIN" },
} as const;

export async function loginAs(page: Page, email: string, password: string = MAUI_PASSWORD) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/programs/, { timeout: 15_000 });
}

export async function expectNoErrorPage(page: Page) {
  await expect(page.locator("text=Internal Server Error")).not.toBeVisible();
  await expect(page.locator("text=Application error")).not.toBeVisible();
  await expect(page.locator("h1", { hasText: /^500$/ })).not.toBeVisible();
  await expect(page.locator("h1", { hasText: /^404$/ })).not.toBeVisible();
}

export async function expectNoEmployeeWording(page: Page) {
  const body = await page.locator("body").innerText();
  expect(body.toLowerCase(), "page must not contain employee/employees/workforce").not.toMatch(
    /employee|employees|workforce/,
  );
}

/**
 * Playwright's API requests default to a 30-second timeout, which is under what a COLD pilot stack
 * takes to answer its first read: `GET /api/runs` measured 32.5 s on the first call and 2.2 s warm
 * against the sandbox on 2026-09-13, so global setup failed the entire suite before a single test ran.
 * This is a client's patience with a first request, not a product bar — the page timings the specs
 * assert are unchanged.
 */
const COLD_READ_TIMEOUT = 120_000;

export async function getAuthToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: MAUI_ACCOUNTS.qualityLead.email, password: MAUI_PASSWORD },
    // The FIRST request of the whole suite, and therefore the one that pays the cold start — raising
    // the timeout on the reads that follow while leaving the default on this one would move the
    // failure a line earlier rather than fix it.
    timeout: COLD_READ_TIMEOUT,
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.token;
}

/**
 * Wait for a list to hold DATA, not its loading skeleton.
 *
 * `SkeletonRow` (`frontend/components/skeleton-loader.tsx`) renders a real `<tr>`, so
 * `tbody tr` is visible from the first paint and a spec that waits on it is not waiting at all. On the
 * pilot sandbox that is several seconds of difference, and the two tests written this way read the
 * page's total while it still said 0 and reported the server's 10,716 as a contract defect. The
 * skeleton is `aria-hidden`, so a row with a patient link is the earliest thing that means "loaded".
 */
export async function waitForDataRows(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.locator("tbody tr a[href^='/employees/']").first()).toBeVisible({ timeout });
}

/**
 * The roster's own footer total, parsed out of the sentence it appears in.
 *
 * Two things make a plain `/^\d+ patients$/` wrong. The page groups with `fmtCount` (a FIXED "en-US"
 * locale, `frontend/lib/format.ts`), so 20,000 renders "20,000 patients" and a `\d+` match finds
 * nothing — which is one of the two reasons this suite passed on CI's 48-patient corpus and failed on
 * the pilot's. And on a single-measure roster the same element continues "(14,872 not in this
 * measure's population)", so the total is a PREFIX of its element's text rather than the whole of it.
 */
export async function statedRosterTotal(page: Page): Promise<number> {
  // `hasNotText: /loaded/` because the roster renders TWO sentences that start the same way: an
  // sr-only live region saying "50 patients loaded" (how many rows are on this page) and the footer
  // saying "20,000 patients" (how many there are). Reading the wrong one would compare a page size
  // with a total and call the difference a defect.
  const text = await page
    .getByText(/^[\d,]+ (patient|patients|employee|employees)\b/)
    .filter({ hasNotText: /loaded/ })
    .last()
    .innerText();
  const match = text.match(/^([\d,]+)\s/);
  expect(match, `"${text}" states a total`).not.toBeNull();
  return Number(match![1].replace(/,/g, ""));
}

/** The page's own spelling of a count — `fmtCount`'s fixed en-US grouping, for an exact assertion. */
export const grouped = (n: number): string => n.toLocaleString("en-US");

/**
 * How many patients the roster holds under `query`, read from the server rather than written down.
 *
 * CI composes 48 corpus patients and the pilot sandbox composes 20,000
 * (`WORKWELL_MAUI_CORPUS_SIZE`), so a spec that hard-codes either number stops being run against the
 * other — which is how `roster.spec.ts` came to assert "48 patients" against a stack with 20,000 of
 * them. `X-Total-Count` is the roster's own total BEFORE paging (`routes/compliance.ts`), so one
 * `pageSize=1` request answers it.
 */
export async function rosterTotal(request: APIRequestContext, token: string, query = ""): Promise<number> {
  const res = await request.get(`${API_BASE}/api/compliance/roster?pageSize=1${query ? `&${query}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status(), "GET /api/compliance/roster").toBe(200);
  const total = Number(res.headers()["x-total-count"] ?? NaN);
  expect(Number.isFinite(total), "the roster reports X-Total-Count").toBe(true);
  return total;
}

/**
 * How many roster patients match `needle` — the roster's own `q`, which matches a name or an external
 * id, case-insensitively (`compliance/roster-read-model.ts`).
 *
 * This exists so a spec can ask "does this name belong to THIS deployment's directory?" for one name,
 * instead of downloading the directory to find out. The roster pages at 200 rows maximum, so building
 * a 20,000-name allow-list costs a hundred requests against a page that takes a second warm — the
 * reason `exports.spec.ts` sampled the first hundred names and then failed every row beyond them.
 */
export async function rosterMatchCount(request: APIRequestContext, token: string, needle: string): Promise<number> {
  return rosterTotal(request, token, `q=${encodeURIComponent(needle)}`);
}

export async function ensureCompletedRun(request: APIRequestContext): Promise<{ runId: string; totalEvaluated: number }> {
  const token = await getAuthToken(request);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const listRes = await request.get(`${API_BASE}/api/runs`, { headers: authHeaders, timeout: COLD_READ_TIMEOUT });
  expect(listRes.status()).toBe(200);
  const runs = (await listRes.json()) as Array<{ runId: string; status: string; scopeType: string; totalEvaluated: number }>;

  const completed = runs.find((r) => r.scopeType === "ALL_PROGRAMS" && r.status === "COMPLETED");
  if (completed) {
    return { runId: completed.runId, totalEvaluated: completed.totalEvaluated };
  }

  // Global setup is a WRITE path too, and it is the one nobody thinks of: reaching it means the target
  // had no completed population run, and on a deployed stack the answer to that is a person looking at
  // why, not a suite starting an hours-long run over 20,000 patients from a laptop.
  if (!writesAllowed()) {
    throw new Error(
      `global setup found no COMPLETED ALL_PROGRAMS run on ${API_BASE} and may not trigger one: ${WRITES_SKIP_REASON}`,
    );
  }

  const triggerRes = await request.post(`${API_BASE}/api/runs/manual`, {
    headers: authHeaders,
    data: { scopeType: "ALL_PROGRAMS", dryRun: false },
  });
  expect(triggerRes.status()).toBe(201);
  const triggerBody = await triggerRes.json();
  const runId = triggerBody.runId;

  await expect
    .poll(
      async () => {
        const res = await request.get(`${API_BASE}/api/runs`, { headers: authHeaders, timeout: COLD_READ_TIMEOUT });
        const all = (await res.json()) as Array<{ runId: string; status: string }>;
        const run = all.find((r) => r.runId === runId);
        return run?.status ?? "";
      },
      { timeout: 180_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe("COMPLETED");

  const finalListRes = await request.get(`${API_BASE}/api/runs`, { headers: authHeaders, timeout: COLD_READ_TIMEOUT });
  const finalRuns = (await finalListRes.json()) as Array<{ runId: string; status: string; totalEvaluated: number }>;
  const finalRun = finalRuns.find((r) => r.runId === runId);
  return { runId, totalEvaluated: finalRun?.totalEvaluated ?? 0 };
}
