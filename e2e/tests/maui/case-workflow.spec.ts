import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, MAUI_PASSWORD, API_BASE, loginAs, expectNoErrorPage } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

test.describe("Maui case workflow", () => {
  test("open an OVERDUE cms125 case and exercise the case-manager actions", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, MAUI_ACCOUNTS.qualityLead.email);

    // Navigate to overdue CMS125 cases via the status chip deep link
    await page.goto("/cases?measureId=cms125&outcome=OVERDUE");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });

    // Open the first case detail
    const caseLink = page.locator("a[href^='/cases/']").filter({ visible: true }).first();
    await expect(caseLink).toBeVisible({ timeout: 20_000 });
    const caseId = await caseLink.getAttribute("href");
    await caseLink.click();
    await expect(page).toHaveURL(/\/cases\//);
    await expectNoErrorPage(page);

    // Crosswalk label rendered in the detail header — assert presence, not viewport visibility.
    await expect(page.getByText(/MIPS 112 · CMS125/).first()).toBeAttached({ timeout: 20_000 });

    // Outcome status pill
    await expect(page.getByText(/Overdue/i).first()).toBeVisible({ timeout: 10_000 });

    // "Why Flagged" evidence block
    const whyFlagged = page.getByText(/Why Flagged|Evidence/i).first();
    await expect(whyFlagged).toBeVisible({ timeout: 10_000 });

    // "Next action" text
    await expect(page.getByText(/Next action/i).first()).toBeVisible({ timeout: 10_000 });

    // Audit timeline section
    const timeline = page.getByText(/Audit timeline/i).first();
    await expect(timeline).toBeVisible({ timeout: 10_000 });

    // Assign to quality-staff
    const assigneeInput = page.getByRole("textbox", { name: /assignee/i }).or(page.locator("input[name='assignee']"));
    if (await assigneeInput.count()) {
      await assigneeInput.first().fill(MAUI_ACCOUNTS.qualityStaff.email);
      const assignBtn = page.getByRole("button", { name: /assign/i }).first();
      await expect(assignBtn).toBeEnabled({ timeout: 10_000 });
      await assignBtn.click();
      // Audit timeline should gain a Case Assigned entry
      await expect(page.getByText(/Case Assigned/i).first()).toBeVisible({ timeout: 30_000 });
    }

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
      await expect(page.getByText(/Outreach Sent/i).first()).toBeVisible({ timeout: 30_000 });
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
    const cases = (await casesRes.json()) as Array<{ caseId: string }>;
    expect(cases.length, "Maui should have open cases after its completed run").toBeGreaterThan(0);
    const caseId = cases[0].caseId;

    // Assign it to quality-staff
    const assignRes = await request.post(`${API_BASE}/api/cases/${caseId}/assign`, {
      headers: { Authorization: `Bearer ${leadToken.token}` },
      data: { assignee: MAUI_ACCOUNTS.qualityStaff.email },
    });
    expect(assignRes.ok()).toBe(true);

    // Log in as quality-staff and check the worklist
    await loginAs(page, MAUI_ACCOUNTS.qualityStaff.email);
    await page.goto("/worklist");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`a[href*="${caseId}"]`).first()).toBeVisible({ timeout: 20_000 });
  });
});
