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
//
// The WHOLE row, in order, compared exactly: the contract is positional (columns are only APPENDED), so
// a `toContain` check per name passed against an inserted or reordered column.
const EXPECTED_HEADERS = [
  "caseId", "patientExternalId", "patientName", "role", "site",
  "measureName", "measureVersion", "evaluationPeriod", "status", "priority",
  "assignee", "currentOutcomeStatus", "nextAction", "lastRunId",
  "createdAt", "updatedAt", "closedAt", "latestOutreachDeliveryStatus",
  "providerId", "payer",
  "closedReason", "closedBy", "liveState", "liveOutcomeStatus", "liveOutcomeRunId",
  "executedLogic",
];

// §6.2, patient spelling (`lastResultDate`, `exclusionStatus`), with #769's `executedLogic` last.
const EXPECTED_OUTCOME_HEADERS = [
  "outcomeId", "runId", "patientExternalId", "patientName", "role", "site",
  "measureName", "measureVersion", "evaluationPeriod", "status",
  "lastResultDate", "complianceWindowDays", "daysOverdue", "roleEligible", "siteEligible", "exclusionStatus", "evaluatedAt",
  "providerId", "payer",
  "executedLogic",
];

/** Quote-aware, so a comma inside a cell (a next action, a name) cannot shift the column read. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The version an `executedLogic` cell names: "CMS125FHIR v1.0.000" or "WorkWell translation of CMS137v15 (ww-2027.1)". */
const versionNamedBy = (logic: string): string | null =>
  logic.match(/^CMS\d+FHIR v(\S+)$/)?.[1] ?? logic.match(/^WorkWell translation of CMS\d+v\d+ \((\S+)\)$/)?.[1] ?? null;

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

    // Header row check: exact, in order.
    const headers = lines[0].split(",").map((h) => h.trim());
    expect(headers, "the §6.3 header, patient spelling, columns only appended").toEqual(EXPECTED_HEADERS);

    // #769: each row names the logic that scored its cited outcome, and `measureVersion` is THAT logic's
    // version — never the authored library's "2.0.0" beside a CMS artifact, never the catalog's "v1.0".
    const versionIdx = headers.indexOf("measureVersion");
    const logicIdx = headers.indexOf("executedLogic");
    let named = 0;
    for (let i = 1; i < lines.length; i++) {
      const row = cells(lines[i].replace(/\r$/, ""));
      expect(row.length, `row ${i}: one cell per header`).toBe(headers.length);
      const version = row[versionIdx] ?? "";
      const logic = row[logicIdx] ?? "";
      expect(version, `row ${i}: never the catalog record's version`).not.toBe("v1.0");
      if (!logic) continue;
      named++;
      const fromLogic = versionNamedBy(logic);
      expect(fromLogic, `row ${i}: '${logic}' is a CMS artifact or a WorkWell translation by name`).not.toBeNull();
      expect(version, `row ${i}: measureVersion is the version '${logic}' names`).toBe(fromLogic);
    }
    // All six measures are routed on this stack, so the cases its runs opened cite rows a named logic scored.
    expect(named, "at least one case names the logic that scored it").toBeGreaterThan(0);

    // §6.2's header, exactly. A run id no run has returns the header alone, which keeps this a header
    // check at any corpus size (the latest run on the pilot holds 120,000 rows).
    const outcomes = await request.get(`${API_BASE}/api/exports/outcomes?format=csv&runId=00000000-0000-4000-8000-000000000000`, {
      headers: authHeaders,
    });
    expect(outcomes.status()).toBe(200);
    const outcomeHeader = (await outcomes.text()).trim().split("\n")[0]!.split(",").map((h) => h.trim());
    expect(outcomeHeader, "the §6.2 header, patient spelling, columns only appended").toEqual(EXPECTED_OUTCOME_HEADERS);

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
