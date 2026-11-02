/**
 * The case page's "what CQL found" (#880): `cqlFindingsOf` on every status it can read.
 *   node --import tsx --test src/case/case-findings.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cqlFindingsOf } from "./case-findings.ts";
import { toCaseDetail } from "./case-detail-read-model.ts";
import type { CaseRecord } from "../stores/case-store.ts";

const pop = (numer: boolean, extra: Partial<Record<"denex" | "denexcep", boolean>> = {}) => ({
  ipp: true, denom: true, numer, denex: false, denexcep: false, ...extra,
});
const official = (ecqmId: string, numer: boolean, extra = {}) => ({ ecqmId, version: "1.0.000", populationResults: pop(numer, extra) });
const facts = (values: Array<[string, string]>, spec = 1) => ({ spec, values: values.map(([define, value]) => ({ define, value })) });
const row = (evidence: unknown, status = "OVERDUE") => ({ status, evidence, outOfPopulation: false });

test("CMS165 below goal: the latest reading, its date first, every recorded value by its define", () => {
  const f = cqlFindingsOf("cms165", row({
    official: official("165FHIR", false),
    cqlFacts: facts([
      ["Most Recent Blood Pressure Day", "2026-03-22"],
      ["Lowest Systolic Reading on Most Recent Blood Pressure Day", "152 'mm[Hg]'"],
      ["Lowest Diastolic Reading on Most Recent Blood Pressure Day", "94 'mm[Hg]'"],
    ]),
  }))!;
  assert.equal(f.status, "LATEST_NOT_QUALIFYING");
  assert.equal(f.date, "2026-03-22");
  assert.equal(f.dateLabel, "Most Recent Blood Pressure Day");
  assert.equal(f.executedLogic, "CMS165FHIR v1.0.000");
  assert.equal(f.rate, null, "a single-rate measure names no rate");
  assert.deepEqual(f.values.map((v) => v.label), [
    "Most Recent Blood Pressure Day",
    "Lowest Systolic Reading on Most Recent Blood Pressure Day",
    "Lowest Diastolic Reading on Most Recent Blood Pressure Day",
  ]);
  assert.equal(f.values[1]!.value, "152 'mm[Hg]'");
});

test("CMS122 with no record: CQL's own answer is the status, never a value row", () => {
  // Inverse measure: no record of an assessment is in the numerator (poor control).
  const f = cqlFindingsOf("cms122", row({
    official: official("122FHIR", true),
    cqlFacts: facts([["Has No Record Of Glycemic Status Assessment", "true"]]),
  }))!;
  assert.equal(f.status, "NONE_FOUND");
  assert.equal(f.date, null);
  assert.deepEqual(f.values, []);
});

test("CMS122 with a reading over 9%: found, dated, and the no-record define left out", () => {
  const f = cqlFindingsOf("cms122", row({
    official: official("122FHIR", true),
    cqlFacts: facts([
      ["Most Recent Glycemic Status Date", "2026-02-10"],
      ["Lowest Glycemic Status Assessment Reading on Most Recent Day", "10.1 '%'"],
      ["Has No Record Of Glycemic Status Assessment", "false"],
    ]),
  }))!;
  assert.equal(f.status, "NUMERATOR_EVIDENCE");
  assert.equal(f.date, "2026-02-10");
  assert.deepEqual(f.values.map((v) => v.label), ["Most Recent Glycemic Status Date", "Lowest Glycemic Status Assessment Reading on Most Recent Day"]);
});

test("CMS125: the logic names no mammogram define, so the page says so", () => {
  const f = cqlFindingsOf("cms125", row({ official: official("125FHIR", false), cqlFacts: facts([]) }))!;
  assert.equal(f.status, "NOT_EXPOSED_BY_LOGIC");
  assert.deepEqual(f.values, []);
});

test("CMS137 missed on Engagement: that rate is the case's, and the logic does not expose it", () => {
  const rate = (numer: boolean) => [
    { populationType: "initial-population", result: true },
    { populationType: "denominator", result: true },
    { populationType: "numerator", result: numer },
  ];
  const f = cqlFindingsOf("cms137", row({
    official: { ecqmId: "137FHIR", version: "1.0.000", populationResults: rate(true), rates: [rate(true), rate(false)] },
    cqlFacts: facts([["Treatment Initiation With Medication Order Dates", "[2026-04-02]"]]),
  }))!;
  assert.equal(f.rate, "Engagement");
  assert.equal(f.status, "NOT_EXPOSED_BY_LOGIC");
  // Missed on Initiation instead: the found treatment is shown under its rate.
  const g = cqlFindingsOf("cms137", row({
    official: { ecqmId: "137FHIR", version: "1.0.000", populationResults: rate(false), rates: [rate(false), rate(false)] },
    cqlFacts: facts([["First SUD Episode During Measurement Period", "Encounter 2026-04-01"]]),
  }))!;
  assert.equal(g.rate, "Initiation");
  assert.equal(g.status, "NONE_FOUND");
  assert.deepEqual(g.values.map((v) => v.label), ["First SUD Episode During Measurement Period"], "context is shown beside none found");
});

test("nothing recorded: a run before #875, another spec version, authored CQL, an errored row", () => {
  assert.equal(cqlFindingsOf("cms165", row({ official: official("165FHIR", false) }))!.status, "NOT_RECORDED_BY_RUN");
  assert.equal(
    cqlFindingsOf("cms165", row({ official: official("165FHIR", false), cqlFacts: facts([["Most Recent Blood Pressure Day", "2026-03-22"]], 2) }))!.status,
    "NOT_RECORDED_BY_RUN",
  );
  const authored = cqlFindingsOf("audiogram", row({ expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }] }))!;
  assert.equal(authored.status, "NOT_RECORDED_BY_RUN");
  assert.equal(authored.executedLogic, null);
  assert.equal(cqlFindingsOf("cms165", row({ evaluationError: "engine failure", message: "x" }, "MISSING_DATA"))!.status, "NOT_RECORDED_BY_RUN");
  assert.equal(cqlFindingsOf("cms165", null), null, "no cited outcome, nothing to read");
});

test("a WorkWell translation reads its own spec, and names its own logic", () => {
  const f = cqlFindingsOf("cms165", row({
    official: { kind: "derived", label: "WorkWell translation of CMS165v15", version: "ww-2027.1", populationResults: pop(false) },
    cqlFacts: facts([["Most Recent Blood Pressure Day", "2027-02-01"]]),
  }))!;
  assert.equal(f.status, "LATEST_NOT_QUALIFYING");
  assert.equal(f.date, "2027-02-01");
  assert.match(f.executedLogic ?? "", /WorkWell translation of CMS165v15/);
});

test("the case detail carries the findings, so every route that rebuilds a case keeps them", () => {
  const c = {
    id: "c-1", employeeId: "emp-006", measureId: "cms165", evaluationPeriod: "2026-06-13", status: "OPEN", priority: "HIGH",
    assignee: null, nextAction: "", nextActionSource: "SYSTEM", currentOutcomeStatus: "OVERDUE", lastRunId: "r-1",
    createdAt: "2026-06-13T00:00:00.000Z", updatedAt: "2026-06-13T00:00:00.000Z", closedAt: null, closedReason: null, closedBy: null,
  } as unknown as CaseRecord;
  const outcome = {
    id: "o-1", runId: "r-1", subjectId: "emp-006", measureId: "cms165", evaluationPeriod: "2026-06-13", status: "OVERDUE",
    evaluatedAt: "2026-06-13T00:00:00.000Z", outOfPopulation: false,
    evidence: { official: official("165FHIR", false), cqlFacts: facts([["Most Recent Blood Pressure Day", "2026-03-22"]]) },
  };
  const detail = toCaseDetail(c, outcome as never);
  assert.equal(detail.cqlFindings?.status, "LATEST_NOT_QUALIFYING");
  assert.equal(detail.cqlFindings?.date, "2026-03-22");
  assert.equal(toCaseDetail(c, null).cqlFindings, null);
});
