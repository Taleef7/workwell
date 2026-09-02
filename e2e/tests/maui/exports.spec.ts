import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, MAUI_PASSWORD, API_BASE } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

const EXPECTED_HEADERS = [
  "caseId", "employeeExternalId", "employeeName", "role", "site",
  "measureName", "measureVersion", "evaluationPeriod", "status", "priority",
  "assignee", "currentOutcomeStatus", "nextAction", "lastRunId",
  "createdAt", "updatedAt", "closedAt", "latestOutreachDeliveryStatus",
];

test.describe("Maui case CSV export", () => {
  test("CSV export has correct header and only Maui patient names", async ({ request }) => {
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: MAUI_ACCOUNTS.qualityLead.email, password: MAUI_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const { token } = (await login.json()) as { token: string };
    const authHeaders = { Authorization: `Bearer ${token}` };

    const rosterRes = await request.get(`${API_BASE}/api/compliance?limit=100`, { headers: authHeaders });
    expect(rosterRes.ok()).toBe(true);
    const rosterPayload = await rosterRes.json();
    const rosterRows = Array.isArray(rosterPayload)
      ? rosterPayload
      : (rosterPayload.rows ?? rosterPayload.data?.rows ?? rosterPayload.data ?? rosterPayload.items ?? []);
    const rosterNames = new Set(
      rosterRows
        .map((row: { employeeName?: string; patientName?: string; name?: string }) => row.employeeName ?? row.patientName ?? row.name)
        .filter((name: unknown): name is string => typeof name === "string"),
    );
    expect(rosterNames.size, "Maui compliance roster should provide patient names").toBeGreaterThan(0);

    const res = await request.get(`${API_BASE}/api/exports/cases?format=csv`, {
      headers: authHeaders,
    });
    expect(res.ok()).toBe(true);
    const csv = await res.text();
    const lines = csv.trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);

    // Header row check
    const headers = lines[0].split(",").map((h) => h.trim());
    for (const expected of EXPECTED_HEADERS) {
      expect(headers, `CSV header should include '${expected}'`).toContain(expected);
    }

    // All employeeName values should be Maui roster names (no emp-/twh identifiers)
    const nameIdx = headers.indexOf("employeeName");
    const extIdx = headers.indexOf("employeeExternalId");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(extIdx).toBeGreaterThan(-1);

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const name = cols[nameIdx]?.trim();
      const extId = cols[extIdx]?.trim();
      if (name) {
        expect(rosterNames, `row ${i}: name '${name}' must resolve to the Maui roster`).toContain(name);
        expect(name, `row ${i}: name '${name}' must not contain 'emp-' or 'twh'`).not.toMatch(/emp-|twh/i);
      }
      if (extId) {
        expect(extId, `row ${i}: externalId '${extId}' must not contain 'emp-' or 'twh'`).not.toMatch(/emp-|twh/i);
      }
    }
  });
});
