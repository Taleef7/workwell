import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { outcomesCsv, outcomesCsvStream, casesCsv, auditCsv } from "./src/export/export-csv.ts";

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
  const fakeEventStore = {
    latestOutreachDeliveryStatus: async () => null,
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
