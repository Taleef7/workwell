import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const testScript = `
  import { outcomesCsv, outcomesCsvStream, casesCsv } from "./src/export/export-csv.ts";

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

  console.log(JSON.stringify({
    csvOutcomes,
    streamedOutcomes,
    csvCases,
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

test("default profile — non-catalog and unresolvable subjects are preserved in outcomes and cases CSV", () => {
  const output = runProfileChild(undefined, testScript);
  const outcomesText = output.csvOutcomes as string;
  const streamedText = output.streamedOutcomes as string;
  const casesText = output.csvCases as string;

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
