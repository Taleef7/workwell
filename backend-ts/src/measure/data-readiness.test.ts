/**
 * Data readiness unit test (#108) — required-element resolution → mapping/freshness + missingness
 * from outcomes → blockers/warnings → overallStatus.
 *   node --import tsx --test src/measure/data-readiness.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeasureRecord } from "../stores/measure-store.ts";
import type { OutcomeStore, OutcomeWithRun, OutcomeMeasureFilter } from "../stores/outcome-store.ts";
import { computeDataReadiness } from "./data-readiness.ts";

function record(requiredDataElements: string[], measureId = "audiogram"): MeasureRecord {
  return {
    measureId,
    name: measureId,
    policyRef: "OSHA 29 CFR 1910.95",
    owner: "system",
    tags: [],
    versionId: "audiogram-v1.0",
    version: "v1.0",
    status: "Active",
    spec: { description: "", eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" }, exclusions: [], complianceWindow: "Annual", requiredDataElements, testFixtures: [] },
    cqlText: "",
    compileStatus: "COMPILED",
    changeSummary: null,
    approvedBy: null,
    activatedAt: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  };
}

/** Stub OutcomeStore: one winning run ("run-latest") holding the given rows. Records the calls made. */
function outcomesStub(rows: Array<{ subjectId: string; status: string; outOfPopulation?: boolean }>) {
  const calls: { runIds?: readonly string[] }[] = [];
  const runRows: OutcomeWithRun[] = rows.map((r) => ({
    runId: "run-latest",
    runStartedAt: "2026-06-13T00:00:00.000Z",
    runScopeType: "ALL_PROGRAMS",
    runStatus: "COMPLETED",
    runTriggeredBy: "scheduler",
    subjectId: r.subjectId,
    measureId: "audiogram",
    status: r.status,
    ...(r.outOfPopulation === undefined ? {} : { outOfPopulation: r.outOfPopulation }),
  }));
  const store = {
    listLatestPopulationRuns: async (measureIds: readonly string[]) =>
      rows.length === 0 ? [] : measureIds.map((measureId) => ({ measureId, runId: "run-latest", runStartedAt: "2026-06-13T00:00:00.000Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "scheduler" })),
    listOutcomesWithRun: async (filter: OutcomeMeasureFilter) => {
      calls.push({ runIds: filter.runIds });
      return runRows.filter((r) => !filter.runIds || filter.runIds.includes(r.runId));
    },
    // The unbounded history scan this module used to make (#664). Present so a regression is loud.
    listOutcomesForMeasure: async () => {
      throw new Error("data readiness must not scan the measure's whole outcome history (#664)");
    },
  } as unknown as OutcomeStore;
  return Object.assign(store, { calls });
}

test("all required elements resolve to MAPPED + FRESH → READY when no missingness", async () => {
  const deps = { outcomes: outcomesStub([{ subjectId: "emp-001", status: "COMPLIANT" }, { subjectId: "emp-002", status: "OVERDUE" }]) };
  const r = await computeDataReadiness(deps, record(["Last audiogram date", "Role", "Site", "Program enrollment"]));
  assert.equal(r.overallStatus, "READY");
  assert.equal(r.blockers.length, 0);
  assert.equal(r.requiredElements.length, 4);
  const audiogram = r.requiredElements.find((e) => e.canonicalElement === "procedure.audiogram")!;
  assert.equal(audiogram.mappingStatus, "MAPPED");
  assert.equal(audiogram.freshnessStatus, "FRESH");
});

test("fhir-backed source freshness does not decay with process uptime (no spurious stale after 24h)", async () => {
  const realNow = Date.now;
  try {
    // Simulate a long-running container (200h uptime), past the STALE/VERY_STALE thresholds. The in-process
    // fhir source must stay FRESH regardless of uptime — it's live every request, never actually "synced".
    Date.now = () => realNow() + 200 * 3_600_000;
    const deps = { outcomes: outcomesStub([{ subjectId: "emp-001", status: "COMPLIANT" }]) };
    const r = await computeDataReadiness(deps, record(["Last audiogram date", "Role", "Site", "Program enrollment"]));
    const audiogram = r.requiredElements.find((e) => e.canonicalElement === "procedure.audiogram")!;
    assert.equal(audiogram.freshnessStatus, "FRESH", "in-process fhir source stays FRESH regardless of uptime");
    assert.equal(r.overallStatus, "READY", "no spurious READY_WITH_WARNINGS from a decayed in-process source");
  } finally {
    Date.now = realNow;
  }
});

test("'Program enrollment' resolves by measure: audiogram → hearingConservation MAPPED", async () => {
  const deps = { outcomes: outcomesStub([{ subjectId: "emp-001", status: "COMPLIANT" }]) };
  const r = await computeDataReadiness(deps, record(["Program enrollment"], "audiogram"));
  const enrollment = r.requiredElements[0]!;
  assert.equal(enrollment.canonicalElement, "programEnrollment.hearingConservation");
  assert.equal(enrollment.mappingStatus, "MAPPED");
});

test("'Program enrollment' for a HEDIS measure is UNMAPPED, not mis-certified as hearing-conservation", async () => {
  const deps = { outcomes: outcomesStub([{ subjectId: "emp-001", status: "COMPLIANT" }]) };
  const r = await computeDataReadiness(deps, record(["Program enrollment"], "hypertension"));
  const enrollment = r.requiredElements[0]!;
  assert.equal(enrollment.canonicalElement, "programEnrollment.hypertension", "measure-specific canonical, not hearingConservation");
  assert.equal(enrollment.mappingStatus, "UNMAPPED");
  assert.equal(r.overallStatus, "NOT_READY");
  assert.ok(r.blockers.some((b) => /Program enrollment.*no source mapping/i.test(b)));
});

test("an unresolvable required element is a blocker → NOT_READY", async () => {
  const deps = { outcomes: outcomesStub([]) };
  const r = await computeDataReadiness(deps, record(["Quantum entanglement level"]));
  assert.equal(r.overallStatus, "NOT_READY");
  assert.ok(r.blockers.some((b) => /no source mapping/i.test(b)));
  assert.equal(r.requiredElements[0]!.mappingStatus, "UNMAPPED");
});

test("missingness > 5% raises a warning on clinical elements → READY_WITH_WARNINGS", async () => {
  // 2 of 3 MISSING_DATA = 67% → warning; clinical element carries the rate + sample subjects.
  const deps = { outcomes: outcomesStub([
    { subjectId: "emp-004", status: "MISSING_DATA" },
    { subjectId: "emp-009", status: "MISSING_DATA" },
    { subjectId: "emp-001", status: "COMPLIANT" },
  ]) };
  const r = await computeDataReadiness(deps, record(["Last audiogram date", "Role"]));
  assert.equal(r.overallStatus, "READY_WITH_WARNINGS");
  assert.ok(r.warnings.some((w) => /missing data outcomes/i.test(w)));
  const clinical = r.requiredElements.find((e) => e.canonicalElement === "procedure.audiogram")!;
  assert.ok(clinical.missingnessRate > 0.05);
  assert.deepEqual(clinical.sampleMissingEmployees, ["emp-004", "emp-009"]);
  // non-clinical element (role) carries no missingness
  const role = r.requiredElements.find((e) => e.canonicalElement === "employee.role")!;
  assert.equal(role.missingnessRate, 0);
});

test("#664: reads only the winning run's rows, never the measure's whole history", async () => {
  const outcomes = outcomesStub([{ subjectId: "emp-001", status: "COMPLIANT" }]);
  await computeDataReadiness({ outcomes }, record(["Last audiogram date"]));
  assert.equal(outcomes.calls.length, 1, "one bounded read");
  assert.deepEqual(outcomes.calls[0]!.runIds, ["run-latest"], "restricted to the winning run in SQL");
});

test("#664: an out-of-population subject is not missing data (ADR-079)", async () => {
  // 1 in-population MISSING_DATA of 2 in population = 50%; the two out-of-population rows are neither
  // numerator nor denominator. Counting them would read 75% and name them as the missing subjects.
  const deps = { outcomes: outcomesStub([
    { subjectId: "emp-001", status: "COMPLIANT" },
    { subjectId: "emp-002", status: "MISSING_DATA" },
    { subjectId: "emp-003", status: "MISSING_DATA", outOfPopulation: true },
    { subjectId: "emp-004", status: "MISSING_DATA", outOfPopulation: true },
  ]) };
  const r = await computeDataReadiness(deps, record(["Last audiogram date"]));
  const clinical = r.requiredElements.find((e) => e.canonicalElement === "procedure.audiogram")!;
  assert.equal(clinical.missingnessRate, 0.5);
  assert.deepEqual(clinical.sampleMissingEmployees, ["emp-002"]);
});

test("no population run yet → the rate is UNKNOWN: a warning, never a silent READY", async () => {
  const r = await computeDataReadiness({ outcomes: outcomesStub([]) }, record(["Last audiogram date"]));
  assert.equal(r.requiredElements[0]!.missingnessRate, 0);
  assert.ok(r.warnings.some((w) => /no completed population run/i.test(w)));
  assert.equal(r.overallStatus, "READY_WITH_WARNINGS", "an unmeasured measure is not READY");
});
