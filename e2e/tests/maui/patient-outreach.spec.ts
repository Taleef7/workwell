import { test, expect } from "@playwright/test";
import {
  API_BASE,
  MAUI_ACCOUNTS,
  WRITES_SKIP_REASON,
  expectNoErrorPage,
  getAuthToken,
  loginAs,
  writesAllowed,
} from "./helpers";

/**
 * One message about several of a patient's gaps, sent from the patient page (#868), the way a quality
 * staffer does it: tick, preview, send, then read the result on the same page.
 *
 * A WRITE spec (`maui-writes`): a sent message cannot be undone, because an outreach record and its audit
 * entry are the ledger saying somebody contacted a patient. So, as `case-workflow.spec.ts`, it runs only
 * against a local stack or when the operator asks for writes by name.
 */

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  test.skip(!writesAllowed(), WRITES_SKIP_REASON);
});

const SENSITIVE = /^cms(2|137)(v\d+)?$/i;

test("a patient with two gaps gets one message, and each gap then says it was emailed", async ({ page, request }) => {
  test.setTimeout(120_000);
  // A patient with at least two open gaps the message names: read from the stack, never written down.
  const token = await getAuthToken(request);
  const res = await request.get(`${API_BASE}/api/cases?status=open&limit=500`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  const cases = (await res.json()) as Array<{ employeeId: string; measureId: string }>;
  const gaps = new Map<string, number>();
  for (const c of cases) if (!SENSITIVE.test(c.measureId)) gaps.set(c.employeeId, (gaps.get(c.employeeId) ?? 0) + 1);
  const patient = [...gaps.entries()].find(([, n]) => n >= 2)?.[0];
  test.skip(!patient, "no patient on this stack has two open gaps a message names");

  await loginAs(page, MAUI_ACCOUNTS.qualityStaff.email);
  await page.goto(`/patients/${encodeURIComponent(patient!)}`);
  const openCases = page.getByTestId("open-cases");
  await expect(openCases).toBeVisible({ timeout: 30_000 });
  await expectNoErrorPage(page);

  const outreach = page.getByTestId("gap-outreach");
  const send = outreach.getByRole("button", { name: /^Send one message about \d+ gaps?$/ });
  await expect(send).toBeDisabled();
  await outreach.getByRole("button", { name: "Preview message" }).click();
  const preview = page.getByTestId("gap-outreach-preview");
  await expect(preview).toHaveCount(1, { timeout: 30_000 });
  // The message names care in plain words and never a measure's title or identifier.
  await expect(preview).toContainText(/you are due for|could not find a record of/);
  await expect(preview).not.toContainText(/CMS\d|MIPS|depress|substance/i);

  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText("Message sent").first()).toBeVisible({ timeout: 30_000 });

  // Back on the same page: every ticked gap now says it was emailed today, by this account.
  const ticked = openCases.getByRole("checkbox", { name: /in the message/ });
  const rows = openCases.locator("tbody tr");
  const n = await rows.count();
  let emailed = 0;
  for (let i = 0; i < n; i++) {
    if (!(await ticked.nth(i).isChecked())) continue;
    await expect(rows.nth(i).getByTestId("last-contact")).toContainText(`Emailed`, { timeout: 30_000 });
    await expect(rows.nth(i).getByTestId("last-contact")).toContainText(MAUI_ACCOUNTS.qualityStaff.email);
    emailed++;
  }
  expect(emailed, "the ticked gaps").toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/Outreach Sent|sent by email/i).first()).toBeVisible();
  await expectNoErrorPage(page);
});
