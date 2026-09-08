import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const API_BASE = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:8080";
export const MAUI_PASSWORD = "Workwell123!";

/**
 * Where `global-setup.ts` parks each role's signed-in browser state, so a spec adopts a session with
 * `test.use({ storageState: ... })` instead of driving the login form again. Gitignored: it holds a
 * live token for a demo account.
 */
const STATE_DIR = path.join(__dirname, "..", "..", ".auth");
export function storageStatePath(email: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  return path.join(STATE_DIR, `${email.replace(/[^a-z0-9]+/gi, "-")}.json`);
}

/**
 * The pilot profile hides the engineering surfaces from every role but ADMIN
 * (`frontend/lib/public-demo.ts`), so `/runs` and `/measures` render AccessDenied for the quality lead.
 * A spec about those pages adopts this state; one about the quality lead's own workflow must not.
 */
export const AS_QUALITY_LEAD = { storageState: storageStatePath("quality-lead@maui.workwell.dev") };
export const AS_ADMIN = { storageState: storageStatePath("admin@maui.workwell.dev") };

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

export async function getAuthToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: MAUI_ACCOUNTS.qualityLead.email, password: MAUI_PASSWORD },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.token;
}

export async function ensureCompletedRun(request: APIRequestContext): Promise<{ runId: string; totalEvaluated: number }> {
  const token = await getAuthToken(request);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const listRes = await request.get(`${API_BASE}/api/runs`, { headers: authHeaders });
  expect(listRes.status()).toBe(200);
  const runs = (await listRes.json()) as Array<{ runId: string; status: string; scopeType: string; totalEvaluated: number }>;

  const completed = runs.find((r) => r.scopeType === "ALL_PROGRAMS" && r.status === "COMPLETED");
  if (completed) {
    return { runId: completed.runId, totalEvaluated: completed.totalEvaluated };
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
        const res = await request.get(`${API_BASE}/api/runs`, { headers: authHeaders });
        const all = (await res.json()) as Array<{ runId: string; status: string }>;
        const run = all.find((r) => r.runId === runId);
        return run?.status ?? "";
      },
      { timeout: 180_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe("COMPLETED");

  const finalListRes = await request.get(`${API_BASE}/api/runs`, { headers: authHeaders });
  const finalRuns = (await finalListRes.json()) as Array<{ runId: string; status: string; totalEvaluated: number }>;
  const finalRun = finalRuns.find((r) => r.runId === runId);
  return { runId, totalEvaluated: finalRun?.totalEvaluated ?? 0 };
}
