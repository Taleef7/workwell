import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { outcomesCsv, outcomesCsvStream, casesCsv, auditCsv, runsCsv } from "./src/export/export-csv.ts";

  const fakeRun = { id: "run-1", scopeType: "MEASURE", startedAt: "2026-07-17T00:00:00.000Z" };
  const outcomes = [
    {
      id: "out-1",
      runId: "run-1",
      subjectId: "pat-001",
      measureId: "cms122",
      evaluationPeriod: "2026-01-01",
      status: "COMPLIANT",
      evidence: {},
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    },
    {
      id: "out-2",
      runId: "run-1",
      subjectId: "cypress-mrn-foreign",
      measureId: "cms122",
      evaluationPeriod: "2026-01-01",
      status: "COMPLIANT",
      evidence: {},
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    },
    {
      id: "out-3",
      runId: "run-1",
      subjectId: "emp-001",
      measureId: "cms122",
      evaluationPeriod: "2026-01-01",
      status: "OVERDUE",
      evidence: {},
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    },
    {
      id: "out-live",
      runId: "run-1",
      subjectId: "wc|live-export-subject",
      measureId: "cms122",
      evaluationPeriod: "2026-01-01",
      status: "COMPLIANT",
      evidence: {},
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    },
  ];

  const cases = [
    {
      id: "case-1",
      employeeId: "pat-001",
      measureId: "cms122",
      evaluationPeriod: "2026-01-01",
      status: "OPEN",
      priority: "HIGH",
      assignee: null,
      nextAction: null,
      currentOutcomeStatus: "COMPLIANT",
      lastRunId: "run-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      closedAt: null,
    },
    {
      id: "case-2",
      employeeId: "cypress-mrn-foreign",
      measureId: "cms122",
      evaluationPeriod: "2026-01-01",
      status: "OPEN",
      priority: "HIGH",
      assignee: null,
      nextAction: null,
      currentOutcomeStatus: "COMPLIANT",
      lastRunId: "run-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      closedAt: null,
    },
    {
      id: "case-3",
      employeeId: "emp-001",
      measureId: "cms122",
      evaluationPeriod: "2026-01-01",
      status: "OPEN",
      priority: "HIGH",
      assignee: null,
      nextAction: null,
      currentOutcomeStatus: "OVERDUE",
      lastRunId: "run-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      closedAt: null,
    },
    {
      id: "case-live",
      employeeId: "wc|live-export-subject",
      measureId: "cms122",
      evaluationPeriod: "2026-01-01",
      status: "OPEN",
      priority: "HIGH",
      assignee: null,
      nextAction: null,
      currentOutcomeStatus: "COMPLIANT",
      lastRunId: "run-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      closedAt: null,
    },
  ];

  const fakeOutcomeStore = {
    listOutcomes: async (_runId, opts) => {
      if (opts && opts.offset != null && opts.limit != null) {
        return outcomes.slice(opts.offset, opts.offset + opts.limit);
      }
      return outcomes;
    },
  };
  const fakeRunStore = {
    listRuns: async () => [fakeRun],
  };
  const fakeCaseStore = {
    listCases: async () => cases,
  };
  // The export asks ONCE for the whole set. The counters are the assertion: a reintroduced per-case
  // call is the defect that answered 504 and held the connection pool on the pilot, and it would be
  // invisible in the CSV text — every cell would still be right.
  const eventCalls = { batched: 0, perCase: 0, idsAsked: [] };
  const fakeEventStore = {
    latestOutreachDeliveryStatus: async () => {
      eventCalls.perCase++;
      return null;
    },
    latestOutreachDeliveryStatuses: async (ids) => {
      eventCalls.batched++;
      eventCalls.idsAsked = [...ids];
      // Three shapes, because the export must tell them apart: a status, a case whose newest action
      // carries NO deliveryStatus (an explicit null — nullish-coalescing and logical-or differ here),
      // and a case the batch never names at all.
      return { "case-1": "SENT", "case-2": null };
    },
  };
  const webChartEnv = {
    WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
    WORKWELL_WEBCHART_API_KEY: "fixture-key",
  };

  const csvOutcomes = await outcomesCsv(fakeOutcomeStore, fakeRunStore, "run-1", webChartEnv);

  const stream = outcomesCsvStream(fakeOutcomeStore, fakeRunStore, "run-1", webChartEnv);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let streamedOutcomes = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    streamedOutcomes += decoder.decode(value);
  }

  const csvCases = await casesCsv(fakeCaseStore, fakeEventStore, {}, webChartEnv);

  // The runs CSV asks one bounded aggregate per run. Its OUTPUT is identical whether those go out
  // together or one at a time, so the concurrency is what has to be asserted.
  const runsFanOut = { inFlight: 0, peak: 0, calls: 0 };
  const manyRuns = ["r1", "r2", "r3", "r4"].map((id) => ({ ...fakeRun, id }));
  const countingOutcomeStore = {
    countOutcomesByStatus: async () => {
      runsFanOut.calls++;
      runsFanOut.peak = Math.max(runsFanOut.peak, ++runsFanOut.inFlight);
      await new Promise((r) => setImmediate(r));
      runsFanOut.inFlight--;
      return [];
    },
  };
  const csvRuns = await runsCsv({ listRuns: async () => manyRuns }, countingOutcomeStore);

  const fakeAuditEventStore = {
    listAuditEvents: async () => [{
      occurredAt: "2026-07-17T00:00:00.000Z",
      eventType: "CASE_ASSIGNED",
      refCaseId: "case-1",
      refRunId: "run-1",
      refMeasureVersionId: null,
      actor: "tester",
      payload: {},
    }],
  };
  const fakeAuditCaseStore = { getCase: async () => cases[0] };
  const csvAudit = await auditCsv(fakeAuditEventStore, fakeAuditCaseStore);

  console.log(JSON.stringify({
    csvOutcomes,
    streamedOutcomes,
    csvCases,
    csvAudit,
    eventCalls,
    runsFanOut,
    csvRuns,
  }));
`;

test("scoped profile (Maui) — outcomes and cases CSV rows exclude foreign and unresolvable subjects", () => {
  const output = runProfileChild("maui", testScript);
  const outcomesText = output.csvOutcomes as string;
  const streamedText = output.streamedOutcomes as string;
  const casesText = output.csvCases as string;

  assert.ok(outcomesText.includes("pat-001"), "Maui-resolvable subject pat-001 must be present in outcomes CSV");
  assert.ok(outcomesText.includes("wc|live-export-subject"), "live wc subject must be present in outcomes CSV via the injected directory");
  assert.ok(!outcomesText.includes("cypress-mrn-foreign"), "foreign Cypress subject must be excluded from outcomes CSV on Maui");
  assert.ok(!outcomesText.includes("emp-001"), "foreign TWH subject emp-001 must be excluded from outcomes CSV on Maui");

  assert.ok(streamedText.includes("pat-001"), "Maui-resolvable subject pat-001 must be present in streamed outcomes CSV");
  assert.ok(streamedText.includes("wc|live-export-subject"), "live wc subject must be present in streamed outcomes CSV via the injected directory");
  assert.ok(!streamedText.includes("cypress-mrn-foreign"), "foreign Cypress subject must be excluded from streamed outcomes CSV on Maui");
  assert.ok(!streamedText.includes("emp-001"), "foreign TWH subject emp-001 must be excluded from streamed outcomes CSV on Maui");

  assert.ok(casesText.includes("pat-001"), "Maui-resolvable subject pat-001 must be present in cases CSV");
  assert.ok(casesText.includes("wc|live-export-subject"), "live wc subject must be present in cases CSV via the injected directory");
  assert.ok(!casesText.includes("cypress-mrn-foreign"), "foreign Cypress subject must be excluded from cases CSV on Maui");
  assert.ok(!casesText.includes("emp-001"), "foreign TWH subject emp-001 must be excluded from cases CSV on Maui");
});

test("the cases CSV asks for every delivery status in ONE call, and an absent one is an empty cell", () => {
  // The pilot's export fired one query per case — ~15,300 through a ten-connection pool — and answered
  // 504 while making every other database-backed page time out. Batching is invisible in the output,
  // so the call counts are what pins it: the CSV text below is identical either way.
  const output = runProfileChild(undefined, testScript);
  const calls = output.eventCalls as { batched: number; perCase: number; idsAsked: string[] };

  assert.equal(calls.batched, 1, "one batched lookup for the whole export");
  assert.equal(calls.perCase, 0, "the per-case query must not be reachable from the export");
  assert.deepEqual(calls.idsAsked, ["case-1", "case-2", "case-3", "case-live"], "every exported case, on the default profile");

  // On MAUI two of those four are filtered out before the lookup — which is the assertion that the
  // lookup happens AFTER the filters. On the default profile the filtered and unfiltered sets are
  // identical, so the check above holds just as well with the call moved above the filter block.
  const maui = runProfileChild("maui", testScript);
  assert.deepEqual(
    (maui.eventCalls as { idsAsked: string[] }).idsAsked,
    ["case-1", "case-live"],
    "asked about the two cases the profile kept, not the two it dropped",
  );

  const rows = (output.csvCases as string).split("\r\n").filter(Boolean);
  // Quote-aware, because a naive `split(",")` shifts every column the moment one field contains a
  // comma — and then this reads a DIFFERENT cell than the one it names, while still passing.
  const fields = (line: string): string[] => {
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
  };
  const header = fields(rows[0]!);
  const statusColumn = header.indexOf("latestOutreachDeliveryStatus");
  assert.ok(statusColumn > 0, "the column is still in the header (DATA_MODEL_CONTRACTS §6.3)");
  const cellFor = (caseId: string) => fields(rows.find((r) => r.startsWith(`${caseId},`))!)[statusColumn];

  assert.equal(cellFor("case-1"), "SENT", "the one case with a record carries its status");
  assert.equal(cellFor("case-2"), "", "an explicit null — newest action with no deliveryStatus — is an empty cell");
  assert.equal(cellFor("case-3"), "", "and so is a case the batch never named");
});

test("the runs CSV asks its per-run aggregate one at a time, not all at once", () => {
  // 200 bounded GROUP BYs fired together still take every connection in a ten-connection pool, so a
  // report nobody is waiting on makes the pages somebody IS waiting on time out. The CSV text is
  // identical either way, which is why this is asserted on the fan-out rather than on the output.
  const output = runProfileChild(undefined, testScript);
  const fanOut = output.runsFanOut as { peak: number; calls: number };

  assert.equal(fanOut.calls, 4, "one aggregate per run");
  assert.equal(fanOut.peak, 1, "and never more than one in flight");
  assert.equal((output.csvRuns as string).split("\r\n").filter(Boolean).length, 5, "header plus a row per run");
});

test("scoped profile (Maui) — outcomes and cases CSV headers use patient subject terminology", () => {
  const output = runProfileChild("maui", testScript);
  const outcomesHeader = (output.csvOutcomes as string).split("\r\n")[0]!;
  const casesHeader = (output.csvCases as string).split("\r\n")[0]!;

  assert.ok(outcomesHeader.includes("patientExternalId,patientName"), "outcomes header must use patient terminology on Maui");
  assert.ok(!outcomesHeader.includes("employeeExternalId"), "outcomes header must not carry employee terminology on Maui");
  assert.ok(outcomesHeader.includes("lastResultDate"), "Maui outcomes header must use result terminology");
  assert.ok(outcomesHeader.includes("exclusionStatus"), "Maui outcomes header must use exclusion terminology");
  assert.ok(!outcomesHeader.includes("lastExamDate"), "Maui outcomes header must not carry exam terminology");
  assert.ok(!outcomesHeader.includes("waiverStatus"), "Maui outcomes header must not carry waiver terminology");
  assert.match(casesHeader, /^caseId,patientExternalId,patientName,role,site,/u, "cases header must use patient terminology on Maui");
  assert.ok(!casesHeader.includes("employeeExternalId"), "cases header must not carry employee terminology on Maui");
});

test("scoped profile (Maui) — audit CSV header uses patient subject terminology", () => {
  const output = runProfileChild("maui", testScript);
  const auditHeader = (output.csvAudit as string).split("\r\n")[0]!;

  assert.match(auditHeader, /,patientId,actor,/u, "audit header must use patient terminology on Maui");
  assert.ok(!auditHeader.includes("employeeId"), "audit header must not carry employee terminology on Maui");
});

test("default profile — non-catalog and unresolvable subjects are preserved in outcomes and cases CSV", () => {
  const output = runProfileChild(undefined, testScript);
  const outcomesText = output.csvOutcomes as string;
  const streamedText = output.streamedOutcomes as string;
  const casesText = output.csvCases as string;
  const outcomesHeader = outcomesText.split("\r\n")[0]!;
  assert.ok(outcomesHeader.includes("employeeExternalId,employeeName"), "default outcomes header keeps employee terminology");
  assert.ok(outcomesHeader.includes("lastExamDate"), "default outcomes header keeps exam terminology");
  assert.ok(outcomesHeader.includes("waiverStatus"), "default outcomes header keeps waiver terminology");

  assert.ok(outcomesText.includes("pat-001"), "pat-001 present on default profile");
  assert.ok(outcomesText.includes("cypress-mrn-foreign"), "unresolvable subject cypress-mrn-foreign must be included on default profile");
  assert.ok(outcomesText.includes("emp-001"), "emp-001 included on default profile");

  assert.ok(streamedText.includes("pat-001"), "pat-001 present in stream on default profile");
  assert.ok(streamedText.includes("cypress-mrn-foreign"), "unresolvable subject present in stream on default profile");
  assert.ok(streamedText.includes("emp-001"), "emp-001 present in stream on default profile");

  assert.ok(casesText.includes("pat-001"), "pat-001 present in cases on default profile");
  assert.ok(casesText.includes("cypress-mrn-foreign"), "unresolvable subject present in cases on default profile");
  assert.ok(casesText.includes("emp-001"), "emp-001 present in cases on default profile");
});

test("default profile — audit CSV header keeps employee subject terminology", () => {
  const output = runProfileChild(undefined, testScript);
  const auditHeader = (output.csvAudit as string).split("\r\n")[0]!;

  assert.match(auditHeader, /,employeeId,actor,/u, "default audit header keeps employee terminology");
  assert.ok(!auditHeader.includes("patientId"), "default audit header must not use patient terminology");
});

test("default profile — WebChart-configured output keeps the pre-change wc lookup", () => {
  const output = runProfileChild(undefined, `
    import { outcomesCsv } from "./src/export/export-csv.ts";
    import { callTool } from "./src/mcp/dispatch.ts";

    const rows = [{
      id: "out-default-wc", runId: "run-default-wc", subjectId: "wc|persisted-default-subject",
      measureId: "cms122", evaluationPeriod: "2026-01-01", status: "COMPLIANT", evidence: {},
      evaluatedAt: "2026-07-17T00:00:00.000Z",
    }];
    const outcomeStore = {
      listOutcomes: async () => rows,
      listLatestPopulationOutcomes: async () => rows,
      listLatestFinalizedOutcomePerMeasure: async () => [],
    };
    const runStore = { listRuns: async () => [{ id: "run-default-wc" }] };
    const webChartEnv = {
      WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
      WORKWELL_WEBCHART_API_KEY: "fixture-key",
    };
    const configuredCsv = await outcomesCsv(outcomeStore, runStore, "run-default-wc", webChartEnv);
    const preChangeCsv = await outcomesCsv(outcomeStore, runStore, "run-default-wc");
    const ctx = {
      deps: { outcomeStore, runStore, webChartEnv },
      events: { appendAudit: async () => {} }, actor: "test", role: "ROLE_ADMIN", enforce: true,
    };
    const configuredEmployee = await callTool("get_employee", { employeeExternalId: "wc|persisted-default-subject" }, ctx);
    const preChangeEmployee = await callTool("get_employee", { employeeExternalId: "wc|persisted-default-subject" }, { ...ctx, deps: { outcomeStore, runStore } });
    console.log(JSON.stringify({ configuredCsv, preChangeCsv, configuredEmployee, preChangeEmployee }));
  `);

  assert.equal(output.configuredCsv, output.preChangeCsv, "configured default CSV must be byte-identical to the pre-change lookup");
  assert.deepEqual(output.configuredEmployee, output.preChangeEmployee, "configured default get_employee must keep EMPLOYEE_NOT_FOUND");
});

test("scoped profile — outcomes export selects the newest run with visible rows", () => {
  const output = runProfileChild("maui", `
    import { outcomesCsv, outcomesCsvStream } from "./src/export/export-csv.ts";

    const runs = [
      { id: "run-new-foreign", scopeType: "ALL_PROGRAMS", startedAt: "2026-07-18T00:00:00.000Z" },
      { id: "run-old-maui", scopeType: "ALL_PROGRAMS", startedAt: "2026-07-17T00:00:00.000Z" },
    ];
    const byRun = {
      "run-new-foreign": [{ id: "out-foreign", runId: "run-new-foreign", subjectId: "emp-001", measureId: "cms122", evaluationPeriod: "2026-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2026-07-18T00:00:00.000Z" }],
      "run-old-maui": [{ id: "out-maui", runId: "run-old-maui", subjectId: "pat-001", measureId: "cms122", evaluationPeriod: "2026-01-01", status: "COMPLIANT", evidence: {}, evaluatedAt: "2026-07-17T00:00:00.000Z" }],
    };
    const outcomeStore = {
      listOutcomes: async (runId, opts) => {
        const rows = byRun[runId] ?? [];
        return opts && opts.offset != null && opts.limit != null ? rows.slice(opts.offset, opts.offset + opts.limit) : rows;
      },
    };
    const runStore = { listRuns: async (limit) => limit === 1 ? runs.slice(0, 1) : runs };
    const webChartEnv = {
      WORKWELL_WEBCHART_BASE_URL: "http://webchart.test",
      WORKWELL_WEBCHART_API_KEY: "fixture-key",
    };
    const stream = outcomesCsvStream(outcomeStore, runStore, undefined, webChartEnv);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let streamed = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamed += decoder.decode(value);
    }
    console.log(JSON.stringify({ csv: await outcomesCsv(outcomeStore, runStore, undefined, webChartEnv), streamed }));
  `);

  assert.ok((output.csv as string).includes("pat-001"), "string export must retain rows from the newest run with Maui-visible subjects");
  assert.ok((output.streamed as string).includes("pat-001"), "stream export must retain rows from the newest run with Maui-visible subjects");
});
