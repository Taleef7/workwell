/**
 * case-read-models unit tests.
 *   node --import tsx --test src/case/case-read-models.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCaseSummary, withScoringLogic } from "./case-read-models.ts";
import type { CaseRecord } from "../stores/case-store.ts";
import type { OutcomeRecord, OutcomeStore } from "../stores/outcome-store.ts";
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
  nextActionSource: "SYSTEM",
  assignmentSource: null,
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

test("every pilot measure is named, the four official-only ones included (#659)", () => {
  // The authored registry holds cms122/cms125 only, so the work list read `cms130`, `cms2`, ...
  for (const id of ["cms122", "cms125", "cms2", "cms130", "cms165", "cms137"]) {
    assert.notEqual(toCaseSummary({ ...CASE, measureId: id }).measureName, id, `${id} renders as a raw id`);
  }
  assert.equal(toCaseSummary({ ...CASE, measureId: "cms130" }).measureName, "Colorectal Cancer Screening");
});

test("toCaseSummary preserves a CMS catalog measureId", () => {
  const summary = toCaseSummary({ ...CASE, measureId: "cms125" });
  assert.equal(summary.measureId, "cms125");
});

// ---- #769: the logic and version of each case's CITED outcome ------------------------------------
// Real evidence shapes: CMS's vendored CMS125 artifact (its committed sha), and the CMS137 translation.
const CMS125 = { official: { ecqmId: "125FHIR", version: "1.0.000", engine: "fqm-execution", artifactSha256: "sha256:97f737fa5262fca1fbb4620e10ce286f612b87b7de4c3fc06fdfe38dfb666ac8" } };
const TRANSLATION = { official: { kind: "derived", label: "WorkWell translation of CMS137v15", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15", ecqmId: null, version: "ww-2027.1" } };
const ERRORED = { evaluationError: "CQL engine failure", message: "boom" };
const AUTHORED = { expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }] };

const outcome = (runId: string, subjectId: string, measureId: string, evidence: unknown, evaluatedAt = "2026-10-01T00:00:00Z"): OutcomeRecord =>
  ({ id: `${runId}-${subjectId}-${measureId}-${evaluatedAt}`, runId, subjectId, measureId, evaluationPeriod: "2026-01-01", status: "OVERDUE", evidence, evaluatedAt }) as OutcomeRecord;

/** A store that records every read; `honourFilters: false` is a fake that ignores `measureId`/`subjectIds`. */
function countingStore(rows: OutcomeRecord[], honourFilters = true) {
  const calls: Array<{ runId: string; measureId?: string; subjectIds?: readonly string[] }> = [];
  const store: Pick<OutcomeStore, "listOutcomes"> = {
    async listOutcomes(runId, opts) {
      calls.push({ runId, measureId: opts?.measureId, subjectIds: opts?.subjectIds });
      return rows
        .filter((r) => r.runId === runId)
        .filter((r) => !honourFilters || !opts?.measureId || r.measureId === opts.measureId)
        .filter((r) => !honourFilters || !opts?.subjectIds || opts.subjectIds.includes(r.subjectId))
        .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
    },
  };
  return { store, calls };
}

const caseFor = (id: string, employeeId: string, measureId: string, lastRunId: string): CaseRecord => ({ ...CASE, id, employeeId, measureId, lastRunId });

const ROWS = [
  // cms137: the WorkWell translation scored this row, whatever today's routing or the vendored manifest says.
  outcome("run-a", "pat-001", "cms137", TRANSLATION),
  outcome("run-a", "pat-002", "cms125", CMS125),
  // An official measure's row whose evaluation failed: no logic, and no authored "2.0.0".
  outcome("run-a", "pat-003", "cms125", ERRORED),
  // Authored CQL (TWH's audiogram; cms125 before its flip): the authored library's version.
  outcome("run-b", "emp-006", "audiogram", AUTHORED),
  outcome("run-b", "pat-004", "cms125", AUTHORED),
];
const CASES = [
  caseFor("c-translated", "pat-001", "cms137", "run-a"),
  caseFor("c-cms", "pat-002", "cms125", "run-a"),
  caseFor("c-errored", "pat-003", "cms125", "run-a"),
  caseFor("c-audiogram", "emp-006", "audiogram", "run-b"),
  caseFor("c-preflip", "pat-004", "cms125", "run-b"),
  caseFor("c-no-row", "pat-009", "cms125", "run-a"),
];

for (const honourFilters of [true, false]) {
  test(`withScoringLogic names each case's CITED row, never routing or the authored library${honourFilters ? "" : " (fake ignoring the filters)"} (#769)`, async () => {
    const { store } = countingStore(ROWS, honourFilters);
    const served = await withScoringLogic(store, CASES.map((c) => toCaseSummary(c)));
    const by = new Map(served.map((s) => [s.caseId, s]));

    const translated = by.get("c-translated")!;
    assert.equal(translated.logic?.kind, "workwell-translation", "the row's evidence, not CMS137FHIR from the manifest or routing");
    assert.deepEqual(translated.logic, { kind: "workwell-translation", label: "WorkWell translation of CMS137v15", version: "ww-2027.1", url: "urn:workwell:measure:cms137:translation", derivedFrom: "CMS137v15" });
    assert.equal("ecqmId" in translated.logic!, false, "a translation never carries a CMS eCQM id");
    assert.equal(translated.measureVersion, "ww-2027.1");

    const cms = by.get("c-cms")!;
    assert.deepEqual(
      cms.logic,
      { kind: "cms-artifact", ecqmId: "CMS125FHIR", version: "1.0.000", derivedFrom: "CMS125v14", status: "draft", statusNote: "posted for public comment Jan–Feb 2026" },
    );
    assert.equal(cms.measureVersion, "1.0.000", "the artifact's version, not the authored library's 2.0.0");

    assert.equal(by.get("c-errored")!.logic, null);
    assert.equal(by.get("c-errored")!.measureVersion, "", "an errored official row names no version — never 2.0.0");
    assert.equal(by.get("c-audiogram")!.logic, null);
    assert.equal(by.get("c-audiogram")!.measureVersion, "1.0.0", "authored CQL keeps its library version");
    assert.equal(by.get("c-preflip")!.logic, null);
    assert.equal(by.get("c-preflip")!.measureVersion, "2.0.0", "a pre-flip authored cms125 row is authored CQL's");
    assert.equal(by.get("c-no-row")!.logic, null);
    assert.equal(by.get("c-no-row")!.measureVersion, "");
  });
}

test("withScoringLogic reads once per (run, measure) for the set, each read bounded to its subjects (#769)", async () => {
  const { store, calls } = countingStore(ROWS);
  await withScoringLogic(store, CASES.map((c) => toCaseSummary(c)));
  // (run-a, cms137), (run-a, cms125), (run-b, audiogram), (run-b, cms125): four groups, four reads.
  assert.deepEqual(
    calls.map((c) => `${c.runId}/${c.measureId}`).sort(),
    ["run-a/cms125", "run-a/cms137", "run-b/audiogram", "run-b/cms125"],
  );
  const runA125 = calls.find((c) => c.runId === "run-a" && c.measureId === "cms125")!;
  assert.deepEqual([...(runA125.subjectIds ?? [])].sort(), ["pat-002", "pat-003", "pat-009"], "only the cases' own subjects, never the whole run");
  for (const c of calls) assert.ok(c.subjectIds, "every read is bounded");

  const none = countingStore(ROWS);
  assert.deepEqual(await withScoringLogic(none.store, []), []);
  assert.equal(none.calls.length, 0, "an empty page reads nothing");
});

test("toCaseSummary alone names no logic and no version: it holds no outcome, so it guesses neither (#769)", () => {
  const summary = toCaseSummary({ ...CASE, measureId: "cms125" });
  assert.equal(summary.logic, null);
  assert.equal(summary.measureVersion, "", "not the authored library's 2.0.0");
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
