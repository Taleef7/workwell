import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  MAUI_ACCOUNTS,
  MAUI_PASSWORD,
  API_BASE,
  WRITES_SKIP_REASON,
  getAuthToken,
  loginAs,
  expectNoErrorPage,
  writesAllowed,
} from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
  // This file assigns a case, moves it to IN_PROGRESS and SENDS OUTREACH, and the last two cannot be
  // undone: an outreach record and its audit entry are the ledger saying somebody contacted a patient.
  // So it runs against a local stack, or when the operator asks for writes by name — never as a side
  // effect of pointing the suite at a URL. It was in the parallel read-only project until 2026-09-13,
  // which is the same footing as the panel mapping that left 289 cases assigned on the pilot sandbox.
  test.skip(!writesAllowed(), WRITES_SKIP_REASON);
});

test.describe("Maui case workflow", () => {
  // This file CAN mutate cases (an outreach POST, an assignment), so its tests run in order rather
  // than racing each other for the same open case. The assignment step below is unconditional; the
  // status and outreach steps are still each behind an `if (await …count())`, so a missing control
  // there skips silently rather than failing — pre-existing, and worth knowing when reading this as
  // a mutation guarantee.
  test.describe.configure({ mode: "serial" });

  /**
   * Every assignment this file makes, with the owner it took the case from. BOTH tests assign — one
   * through the UI and one through the API — and an earlier version recorded only the second, so a
   * write-enabled run leaked the first case permanently and then broke the sibling write spec's
   * "is the account back where it started" check. Caught in review.
   */
  const assigned: Array<{ token: string; caseId: string; assignee: string | null }> = [];

  /** The case's owner right now, so the restore returns it rather than clearing it. */
  async function priorAssignee(request: APIRequestContext, token: string, caseId: string): Promise<string | null> {
    const res = await request.get(`${API_BASE}/api/cases/${caseId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), `GET /api/cases/${caseId}`).toBe(200);
    const detail = (await res.json()) as { assignee?: string | null };
    expect(Object.keys(detail), "the case reports its assignee").toContain("assignee");
    return detail.assignee ?? null;
  }

  test("open an OVERDUE cms125 case and exercise the case-manager actions", async ({ page, request }) => {
    test.setTimeout(120_000);
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);

    // Navigate to overdue CMS125 cases via the status chip deep link
    await page.goto("/cases?measureId=cms125&outcome=OVERDUE");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });

    // Open the first case detail
    const caseLink = page.locator("a[href^='/cases/']").filter({ visible: true }).first();
    await expect(caseLink).toBeVisible({ timeout: 20_000 });
    await caseLink.click();
    await expect(page).toHaveURL(/\/cases\//);
    await expectNoErrorPage(page);

    // Crosswalk label rendered in the detail header — assert presence, not viewport visibility.
    await expect(page.getByText(/MIPS 112 · CMS125/).first()).toBeAttached({ timeout: 20_000 });

    // Outcome status pill — the detail page renders it twice (a responsive duplicate is display:none),
    // so pick the VISIBLE one rather than the first in DOM order.
    await expect(page.getByText(/Overdue/i).filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });

    // "Why Flagged" evidence block
    const whyFlagged = page.getByText(/Why Flagged|Evidence/i).filter({ visible: true }).first();
    await expect(whyFlagged).toBeVisible({ timeout: 10_000 });

    // "Next action" text
    await expect(page.getByText(/Next action/i).filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });

    // Audit timeline section
    const timeline = page.getByText(/Audit timeline/i).filter({ visible: true }).first();
    await expect(timeline).toBeVisible({ timeout: 10_000 });

    // Remember who owns it BEFORE the click, so `afterAll` can put it back.
    const openedId = decodeURIComponent((page.url().match(/\/cases\/([^/?#]+)/) ?? [])[1] ?? "");
    expect(openedId, "the case detail URL names the case").not.toBe("");
    const token = await getAuthToken(request);
    assigned.push({ token, caseId: openedId, assignee: await priorAssignee(request, token, openedId) });

    // Assign to quality-staff. The control offers the deployment's assignable accounts; typing an
    // address is deliberately not possible, so the test picks the option a person would.
    const assigneeSelect = page.getByRole("combobox", { name: /assignee/i }).filter({ visible: true }).first();
    await expect(assigneeSelect).toBeVisible({ timeout: 10_000 });
    await assigneeSelect.click();
    await page.getByRole("option", { name: MAUI_ACCOUNTS.qualityStaff.email }).first().click();
    const assignBtn = page.getByRole("button", { name: /^assign$/i }).first();
    await expect(assignBtn).toBeEnabled({ timeout: 10_000 });
    await assignBtn.click();
    // Audit timeline should gain a Case Assigned entry
    await expect(page.getByText(/Case Assigned/i).first()).toBeVisible({ timeout: 30_000 });
    // ...and the case must actually BE assigned. The timeline entry alone is satisfied by history: the
    // restore puts the assignee back but leaves the audit trail, so on the second run against the same
    // stack "Case Assigned" is already on the page before the click and the assertion above passes
    // whether or not the control did anything.
    await expect
      .poll(() => priorAssignee(request, token, openedId), { timeout: 30_000 })
      .toBe(MAUI_ACCOUNTS.qualityStaff.email);

    // Change status to IN_PROGRESS if offered
    const statusButton = page.getByRole("button", { name: /start|in progress/i }).first();
    if (await statusButton.count()) {
      await statusButton.click();
      await expect(page.getByText(/IN_PROGRESS|In Progress/i).first()).toBeVisible({ timeout: 30_000 });
    }

    // Send outreach via the preview/send flow
    const channelSelect = page.getByRole("combobox", { name: /channel/i }).filter({ visible: true }).first();
    if (await channelSelect.count()) {
      await channelSelect.click();
      await page.getByRole("option", { name: "SMS", exact: true }).filter({ visible: true }).first().click();
      await expect(channelSelect).toContainText("SMS");

      const previewBtn = page.getByRole("button", { name: /preview outreach/i }).filter({ visible: true }).first();
      await previewBtn.click();
      const sendBtn = page.getByRole("button", { name: /send outreach/i }).filter({ visible: true }).first();
      await expect(sendBtn).toBeEnabled({ timeout: 30_000 });
      await sendBtn.click();
      await expect(page.getByText(/Outreach Sent/i).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    }
  });

  test("assigned case appears in quality-staff's worklist", async ({ page, request }) => {
    test.setTimeout(120_000);

    // First, assign a case via API as quality-lead
    const leadLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: MAUI_ACCOUNTS.qualityLead.email, password: MAUI_PASSWORD },
    });
    expect(leadLogin.ok()).toBe(true);
    const leadToken = (await leadLogin.json()) as { token: string };

    // Find an open case
    const casesRes = await request.get(`${API_BASE}/api/cases?status=open`, {
      headers: { Authorization: `Bearer ${leadToken.token}` },
    });
    expect(casesRes.ok()).toBe(true);
    const cases = (await casesRes.json()) as Array<{ caseId: string; assignee?: string | null }>;
    expect(cases.length, "Maui should have open cases after its completed run").toBeGreaterThan(0);
    const caseId = cases[0].caseId;
    // Remember who had it, so the restore below puts it back rather than blanket-unassigning a case
    // an operator had already placed with somebody. The key's PRESENCE is asserted rather than
    // defaulted: `?? null` on an absent field would read "we don't know" as "nobody", and the restore
    // would then clear an assignment this test never made.
    expect(Object.keys(cases[0]), "the case reports its assignee").toContain("assignee");
    assigned.push({ token: leadToken.token, caseId, assignee: cases[0].assignee ?? null });

    // Assign it to quality-staff — the assignee travels as a query parameter (what the cases page sends).
    const assignRes = await request.post(
      `${API_BASE}/api/cases/${caseId}/assign?assignee=${encodeURIComponent(MAUI_ACCOUNTS.qualityStaff.email)}`,
      { headers: { Authorization: `Bearer ${leadToken.token}` } },
    );
    expect(assignRes.ok()).toBe(true);
    const assignBody = (await assignRes.json()) as { assignee?: string | null };
    expect(assignBody.assignee, "the API must record the assignee we sent").toBe(MAUI_ACCOUNTS.qualityStaff.email);

    // Log in as quality-staff and check "My Cases" (the cases page's assignee-scoped view; the
    // /worklist page is the gap list, which does not link cases by id).
    await loginAs(page, MAUI_ACCOUNTS.qualityStaff.email);
    await page.goto("/cases?view=mine");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`a[href*="${caseId}"]`).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  });

  /**
   * Put every assignment back — both of them. They are the only writes in this file that CAN go back;
   * the status change and the outreach record are a ledger of something having happened, which is the
   * argument for the guard at the top rather than for a cleverer cleanup.
   *
   * An empty `assignee` is the unassign path, not a validation error (`routes/cases.ts` treats an
   * absent or blank value as "clear this" and only validates a non-empty one).
   */
  test.afterAll(async ({ playwright }) => {
    if (assigned.length === 0) return;
    const ctx = await playwright.request.newContext();
    const failures: string[] = [];
    try {
      for (const { token, caseId, assignee } of assigned) {
        const res = await ctx.post(
          `${API_BASE}/api/cases/${caseId}/assign?assignee=${encodeURIComponent(assignee ?? "")}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        // Collect rather than throw on the first, or one failure hides the cases still to restore.
        if (!res.ok()) failures.push(`${caseId}: ${res.status()} ${await res.text()}`);
      }
    } finally {
      await ctx.dispose();
    }
    if (failures.length > 0) throw new Error(`restoring assignments failed — ${failures.join("; ")}`);
  });
});
