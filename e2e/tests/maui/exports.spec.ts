import { test, expect } from "@playwright/test";
import { MAUI_ACCOUNTS, MAUI_PASSWORD, API_BASE, rosterMatchCount, rosterTotal } from "./helpers";

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_PROFILE !== "maui", "maui profile only");
});

// The PATIENT spelling of the §6.3 case-export contract (`docs/DATA_MODEL_CONTRACTS.md`): on a
// deployment whose `DEPLOYMENT_PROFILE.subjectTerm` is "patient", the two subject columns are named
// `patientExternalId`/`patientName` and every other header and the column order are unchanged. This
// list said `employeeExternalId` — the DEFAULT profile's spelling — so the assertion contradicted the
// contract the export is written to, and the Maui stack was right and the test was wrong.
const EXPECTED_HEADERS = [
  "caseId", "patientExternalId", "patientName", "role", "site",
  "measureName", "measureVersion", "evaluationPeriod", "status", "priority",
  "assignee", "currentOutcomeStatus", "nextAction", "lastRunId",
  "createdAt", "updatedAt", "closedAt", "latestOutreachDeliveryStatus",
];

test.describe("Maui case CSV export", () => {
  test("CSV export has correct header and only Maui patient names", async ({ request }) => {
    // Budget past the gateway rather than under it, so a failure here NAMES the defect instead of
    // reading as a slow suite. Measured on the pilot sandbox on 2026-09-13:
    // `GET /api/exports/cases?format=csv` answers **504 after 60.2 s** — the proxy cuts the request,
    // so at 20,000 patients this export does not complete at all. `casesCsv` issues one
    // `latestOutreachDeliveryStatus` query PER CASE (~15,300 of them through a ten-connection pool at
    // Neon's ~40 ms), which is the cause and is fixed by the batched lookup in the read-path PR. Until
    // that lands, this test fails against the sandbox on purpose and passes on CI's 48-patient corpus.
    //
    // It is also DISRUPTIVE while it fails, which is worth knowing before running the suite against a
    // shared stack: the export holds the whole connection pool, so every database-backed endpoint
    // queues behind it. Measured the same day — `/api/panels` went from 0.3 s idle to three
    // consecutive 45 s timeouts during an export, while `/api/version`, which touches no database,
    // stayed at 0.2 s throughout. A whole-suite sandbox run therefore shows failures in the specs that
    // happen to follow this one, and they are this test's shadow rather than defects of their own.
    test.setTimeout(180_000);
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: MAUI_ACCOUNTS.qualityLead.email, password: MAUI_PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const { token } = (await login.json()) as { token: string };
    const authHeaders = { Authorization: `Bearer ${token}` };

    expect(await rosterTotal(request, token), "the Maui roster must hold patients").toBeGreaterThan(0);

    const res = await request.get(`${API_BASE}/api/exports/cases?format=csv`, {
      headers: authHeaders,
      timeout: 150_000,
    });
    expect(res.status(), "the case export must answer, not 504 at the gateway").toBe(200);
    const csv = await res.text();
    const lines = csv.trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);

    // Header row check
    const headers = lines[0].split(",").map((h) => h.trim());
    for (const expected of EXPECTED_HEADERS) {
      expect(headers, `CSV header should include '${expected}'`).toContain(expected);
    }

    // All patient names should be Maui roster names (no emp-/twh identifiers)
    const nameIdx = headers.indexOf("patientName");
    const extIdx = headers.indexOf("patientExternalId");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(extIdx).toBeGreaterThan(-1);

    // EVERY row is checked for the occupational deployment's identifiers — that is the profile-isolation
    // guard, and it costs nothing at any corpus size.
    const sampled: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const name = cols[nameIdx]?.trim();
      const extId = cols[extIdx]?.trim();
      if (name) {
        expect(name, `row ${i}: name '${name}' must not contain 'emp-' or 'twh'`).not.toMatch(/emp-|twh/i);
        if (sampled.length < 5 && !sampled.includes(name)) sampled.push(name);
      }
      if (extId) {
        expect(extId, `row ${i}: externalId '${extId}' must not contain 'emp-' or 'twh'`).not.toMatch(/emp-|twh/i);
      }
    }

    // And a SAMPLE is checked the other way — that the name belongs to this deployment's directory —
    // by asking the roster about it rather than by downloading the roster to compare against.
    //
    // The allow-list this replaces was built from one 100-row page. On the 48-patient CI corpus that
    // page IS the roster, so every exported name was in it and the assertion looked exact; on the
    // pilot's 20,000 it is the first half of one percent, so nearly every row failed against a stack
    // that was behaving correctly. The roster pages at 200 rows maximum, so the honest version of the
    // old assertion is a hundred requests, and the question "does this name exist here?" needs one.
    expect(sampled.length, "the export must carry patient names to check").toBeGreaterThan(0);
    for (const name of sampled) {
      expect(
        await rosterMatchCount(request, token, name),
        `exported name '${name}' must resolve on the Maui roster`,
      ).toBeGreaterThan(0);
    }
  });
});
