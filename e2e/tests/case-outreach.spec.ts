import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, DEMO_PASSWORD, API_BASE, apiReachable, loginAs } from "./helpers";

// Simulated send only (WORKWELL_EMAIL_PROVIDER=simulated on the local stack) — allowed.
test.describe("Case outreach action", () => {
  test("send outreach with a channel selection updates the audit timeline", async ({ page, request }) => {
    test.setTimeout(120_000);
    test.skip(!(await apiReachable(request)), `backend API not reachable at ${API_BASE}`);

    // Discover an OPEN case deterministically via the API (UI list ordering varies).
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: ADMIN_EMAIL, password: DEMO_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const { token } = (await login.json()) as { token: string };
    const casesRes = await request.get(`${API_BASE}/api/cases?status=open`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(casesRes.ok()).toBe(true);
    const cases = (await casesRes.json()) as Array<{ caseId: string; status: string }>;
    test.skip(cases.length === 0, "no OPEN cases on the local stack");
    const caseId = cases[0].caseId;

    await loginAs(page, ADMIN_EMAIL);
    await page.goto(`/cases/${caseId}`);
    await expect(page.getByText(/Audit timeline/i).first()).toBeVisible({ timeout: 30_000 });

    const timelineEventsBefore = await page.getByText(/Outreach Sent/i).count();

    // Channel select (custom @mieweb/ui combobox): pick SMS on the visible (desktop) instance.
    const channelSelect = page
      .getByRole("combobox", { name: "Channel" })
      .filter({ visible: true })
      .first();
    await expect(channelSelect).toBeVisible({ timeout: 20_000 });
    await channelSelect.click();
    await page.getByRole("option", { name: "SMS", exact: true }).filter({ visible: true }).first().click();
    await expect(channelSelect).toContainText("SMS");

    // Desktop flow requires a preview before send.
    const previewButton = page.getByRole("button", { name: /Preview outreach/i }).filter({ visible: true }).first();
    await previewButton.click();
    const sendButton = page.getByRole("button", { name: /Send outreach/i }).filter({ visible: true }).first();
    await expect(sendButton).toBeEnabled({ timeout: 30_000 });

    const outreachResponse = page.waitForResponse(
      (r) => r.url().includes("/actions/outreach") && r.request().method() === "POST",
      { timeout: 30_000 }
    );
    await sendButton.click();
    const response = await outreachResponse;
    expect(response.ok(), `outreach POST returned ${response.status()}`).toBe(true);

    // The timeline gains a new "Outreach Sent" audit entry.
    await expect
      .poll(async () => page.getByText(/Outreach Sent/i).count(), { timeout: 30_000 })
      .toBeGreaterThan(timelineEventsBefore);
  });
});
