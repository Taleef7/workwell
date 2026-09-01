/**
 * case-read-models unit tests.
 *   node --import tsx --test src/case/case-read-models.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCaseSummary } from "./case-read-models.ts";
import type { CaseRecord } from "../stores/case-store.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const CASE: CaseRecord = {
  id: "case-001",
  employeeId: "emp-006",
  measureId: "adult_immunization",
  evaluationPeriod: "2026-01-01",
  status: "OPEN",
  priority: "MEDIUM",
  assignee: null,
  nextAction: "Send outreach",
  currentOutcomeStatus: "MISSING_DATA",
  lastRunId: "run-001",
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:00:00.000Z",
  closedAt: null,
  closedReason: null,
  closedBy: null,
};

test("toCaseSummary includes measureId matching the case record", () => {
  const summary = toCaseSummary(CASE);
  assert.equal(summary.measureId, "adult_immunization");
});

test("toCaseSummary preserves a CMS catalog measureId", () => {
  const summary = toCaseSummary({ ...CASE, measureId: "cms125" });
  assert.equal(summary.measureId, "cms125");
});

const testScript = `
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
  import { SqliteCaseStore } from "./src/stores/sqlite/case-store-sqlite.ts";
  import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
  import { handleCases } from "./src/routes/cases.ts";
  import { bucketPeriodForMeasure } from "./src/run/compliance-period.ts";

  const TODAY = new Date().toISOString().slice(0, 10);
  const CYCLE = bucketPeriodForMeasure("cms122", TODAY);

  const db = await createSqliteD1(":memory:");
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
  const env = { DB: db };
  const store = new SqliteCaseStore(db);
  const runStore = new SqliteRunStore(db);

  const run = await runStore.createRun({
    scopeType: "MEASURE",
    scopeId: "cms122",
    triggeredBy: "test",
    requestedScope: { measureId: "cms122" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });

  const patCase = await store.upsertFromOutcome({ runId: run.id, subjectId: "pat-001", measureId: "cms122", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  const foreignCase = await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-001", measureId: "cms122", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  const unresolvedCase = await store.upsertFromOutcome({ runId: run.id, subjectId: "cypress-mrn-foreign", measureId: "cms122", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });

  const res = await handleCases(new Request("http://x/api/cases?status=open"), env);
  const summaries = await res.json();
  const detail = async (caseId) => {
    const response = await handleCases(new Request("http://x/api/cases/" + caseId), env);
    return { status: response.status, body: await response.json() };
  };
  const patDetail = await detail(patCase.id);
  const foreignDetail = await detail(foreignCase.id);
  const unresolvedDetail = await detail(unresolvedCase.id);

  console.log(JSON.stringify({
    employeeIds: summaries.map(s => s.employeeId),
    employeeNames: summaries.map(s => s.employeeName),
    patDetail,
    foreignDetail,
    unresolvedDetail,
  }));
`;

test("scoped profile (Maui) — /api/cases worklist excludes foreign and unresolvable subjects", () => {
  const output = runProfileChild("maui", testScript);
  const employeeIds = output.employeeIds as string[];
  const employeeNames = output.employeeNames as string[];

  assert.ok(employeeIds.includes("pat-001"), "pat-001 must be present in /api/cases on Maui");
  assert.ok(!employeeIds.includes("emp-001"), "emp-001 must be excluded from /api/cases on Maui");
  assert.ok(!employeeIds.includes("cypress-mrn-foreign"), "unresolvable subject must be excluded from /api/cases on Maui");
  assert.ok(!employeeNames.includes("cypress-mrn-foreign"), "unresolvable subject ID must never appear as employeeName on Maui");
});

test("scoped profile (Maui) — /api/cases/:id returns 404 for foreign and unresolvable subjects", () => {
  const output = runProfileChild("maui", testScript);
  const foreignDetail = output.foreignDetail as { status: number; body: Record<string, unknown> };
  const unresolvedDetail = output.unresolvedDetail as { status: number; body: Record<string, unknown> };

  assert.equal(foreignDetail.status, 404);
  assert.equal(foreignDetail.body.error, "not_found");
  assert.equal(unresolvedDetail.status, 404);
  assert.equal(unresolvedDetail.body.error, "not_found");
});

test("default profile — /api/cases preserves unresolvable and non-catalog subjects", () => {
  const output = runProfileChild(undefined, testScript);
  const employeeIds = output.employeeIds as string[];

  assert.ok(employeeIds.includes("pat-001"), "pat-001 present on default profile");
  assert.ok(employeeIds.includes("emp-001"), "emp-001 present on default profile");
  assert.ok(employeeIds.includes("cypress-mrn-foreign"), "unresolvable subject present on default profile");
});

test("default profile — /api/cases/:id preserves foreign and unresolvable subjects", () => {
  const output = runProfileChild(undefined, testScript);
  const patDetail = output.patDetail as { status: number; body: Record<string, unknown> };
  const foreignDetail = output.foreignDetail as { status: number; body: Record<string, unknown> };
  const unresolvedDetail = output.unresolvedDetail as { status: number; body: Record<string, unknown> };

  assert.equal(patDetail.status, 200);
  assert.equal(foreignDetail.status, 200);
  assert.equal(foreignDetail.body.employeeName, "Demo Author");
  assert.equal(unresolvedDetail.status, 200);
  assert.equal(unresolvedDetail.body.employeeName, "cypress-mrn-foreign");
});
