import { expect, type Page, type APIRequestContext } from "@playwright/test";

export const API_BASE = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:8080";
export const MAUI_PASSWORD = "Workwell123!";

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
