import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import {
  CMS122_OFFICIAL_META,
  CMS122_DIABETES_OID,
  CMS122_HBA1C_OID,
  CMS122_QUALIFYING_VISIT_OIDS,
  CMS122_HOSPICE_OID,
  CMS122_PALLIATIVE_OID,
  enrichForOfficialCms122,
  type Expansions,
} from "./cms122-official.ts";
import type { ValueSetResolver } from "../engine/cql/value-set-resolver.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { seededTargetFor } from "../run/distribution.ts";

const DIABETES_CODE = { code: "44054006", system: "http://snomed.info/sct" };
const HBA1C_CODE = { code: "4548-4", system: "http://loinc.org" };
const GMI_CODE = { code: "97506-0", system: "http://loinc.org" };
const OFFICE_VISIT_CODE = { code: "99213", system: "http://www.ama-assn.org/go/cpt" };
const fixtureResolver: ValueSetResolver = {
  expand: (oid) =>
    Promise.resolve(
      oid === CMS122_DIABETES_OID ? [DIABETES_CODE]
      : oid === CMS122_HBA1C_OID ? [HBA1C_CODE]
      : oid === "2.16.840.1.113883.3.464.1003.101.12.1001" ? [OFFICE_VISIT_CODE]
      : [],
    ),
};

function bundle(parts: {
  birthDate: string; visit?: boolean; diabetes?: boolean; hba1c?: number | "missing" | null;
  hba1cDate?: string; // YYYY-MM-DD for the HbA1c Observation effective date (default in-period)
  gmi?: number | null; // a Glucose Management Indicator (LOINC 97506-0) result value
  gmiDate?: string; // YYYY-MM-DD for the GMI Observation effective date (default in-period, newer than the HbA1c default)
  visitDate?: string; // YYYY-MM-DD for the qualifying-visit Encounter's single-day period (default in-period)
}): unknown {
  const entry: Array<{ resource: unknown }> = [
    { resource: { resourceType: "Patient", id: "p1", birthDate: parts.birthDate } },
  ];
  const vd = parts.visitDate ?? "2026-03-01";
  if (parts.visit) entry.push({ resource: { resourceType: "Encounter", id: "e1", status: "finished", subject: { reference: "Patient/p1" }, type: [{ coding: [OFFICE_VISIT_CODE] }], period: { start: `${vd}T00:00:00`, end: `${vd}T01:00:00` } } });
  if (parts.diabetes) entry.push({ resource: { resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1" }, code: { coding: [DIABETES_CODE] } } });
  const hd = parts.hba1cDate ?? "2026-04-01";
  if (parts.hba1c != null && parts.hba1c !== "missing") entry.push({ resource: { resourceType: "Observation", id: "o1", status: "final", subject: { reference: "Patient/p1" }, code: { coding: [HBA1C_CODE] }, effectiveDateTime: `${hd}T00:00:00`, valueQuantity: { value: parts.hba1c, unit: "%", system: "http://unitsofmeasure.org", code: "%" } } });
  const gd = parts.gmiDate ?? "2026-05-01";
  if (parts.gmi != null) entry.push({ resource: { resourceType: "Observation", id: "gmi1", status: "final", subject: { reference: "Patient/p1" }, code: { coding: [GMI_CODE] }, effectiveDateTime: `${gd}T00:00:00`, valueQuantity: { value: parts.gmi, unit: "%", system: "http://unitsofmeasure.org", code: "%" } } });
  return { resourceType: "Bundle", type: "collection", entry };
}

async function evalOfficial(b: unknown, evalDate = "2026-06-30") {
  const engine = new CqlExecutionEngine({ valueSetResolver: fixtureResolver });
  return engine.evaluate({ measureId: "cms122_official", metaOverride: CMS122_OFFICIAL_META, patientBundle: b, evaluationDate: evalDate });
}
function define(o: Awaited<ReturnType<typeof evalOfficial>>, name: string): unknown {
  return o.evidence.expressionResults.find((e) => e.define === name)?.result;
}

test("official CMS122: in-IPP, HbA1c 7 → COMPLIANT", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: 7 }));
  assert.equal(define(o, "Initial Population"), true);
  assert.equal(o.outcome, "COMPLIANT");
});
test("official CMS122: in-IPP, HbA1c 10 → OVERDUE (numerator)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: 10 }));
  assert.equal(o.outcome, "OVERDUE");
});
test("official CMS122: in-IPP, no glycemic assessment (HbA1c or GMI) → OVERDUE (missing counts as numerator)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: "missing" }));
  assert.equal(define(o, "Glycemic Assessment Missing"), true);
  assert.equal(o.outcome, "OVERDUE");
});
// GMI (Glucose Management Indicator, LOINC 97506-0) is the official numerator's HbA1c-equivalent
// glycemic-status assessment. The numerator uses the most recent of HbA1c OR GMI within the period.
test("official CMS122: in-IPP, GMI > 9 and no HbA1c → OVERDUE (numerator via GMI)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, gmi: 10 }));
  assert.equal(define(o, "Glycemic Assessment Missing"), false);
  assert.equal(define(o, "Most Recent Glycemic Value"), 10);
  assert.equal(o.outcome, "OVERDUE");
});
test("official CMS122: in-IPP, GMI ≤ 9 and no HbA1c → COMPLIANT (not numerator)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, gmi: 7 }));
  assert.equal(define(o, "Glycemic Assessment Missing"), false);
  assert.equal(o.outcome, "COMPLIANT");
});
test("official CMS122: older HbA1c ≤ 9 and newer GMI > 9 → OVERDUE (most-recent glycemic assessment wins)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: 7, hba1cDate: "2026-01-01", gmi: 10, gmiDate: "2026-05-01" }));
  assert.equal(define(o, "Most Recent Glycemic Value"), 10);
  assert.equal(o.outcome, "OVERDUE");
});
test("official CMS122: newer HbA1c ≤ 9 and older GMI > 9 → COMPLIANT (most-recent glycemic assessment wins)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: 7, hba1cDate: "2026-05-01", gmi: 10, gmiDate: "2026-01-01" }));
  assert.equal(define(o, "Most Recent Glycemic Value"), 7);
  assert.equal(o.outcome, "COMPLIANT");
});
test("official CMS122: no qualifying visit → NOT in IPP", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: false, diabetes: true, hba1c: 7 }));
  assert.equal(define(o, "Has Qualifying Visit"), false);
  assert.equal(define(o, "Initial Population"), false);
});
test("official CMS122: age 80 → NOT in IPP", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1944-01-01", visit: true, diabetes: true, hba1c: 7 }));
  assert.equal(define(o, "Age 18 To 75"), false);
  assert.equal(define(o, "Initial Population"), false);
});
// Codex P2: the qualifying visit must occur DURING the measurement period. Eval date 2026-06-30 →
// MP = [2025-06-30, 2026-06-30]. An in-period visit qualifies; an out-of-period FUTURE visit does not.
test("official CMS122: in-period qualifying visit → Has Qualifying Visit true / in IPP", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: 7, visitDate: "2026-04-01" }));
  assert.equal(define(o, "Has Qualifying Visit"), true);
  assert.equal(define(o, "Initial Population"), true);
});
test("official CMS122: out-of-period (future) qualifying visit → Has Qualifying Visit false / NOT in IPP", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: 7, visitDate: "2027-04-01" }));
  assert.equal(define(o, "Has Qualifying Visit"), false);
  assert.equal(define(o, "Initial Population"), false);
});

const EXPANSIONS: Expansions = new Map([
  [CMS122_DIABETES_OID, [DIABETES_CODE]],
  [CMS122_HBA1C_OID, [HBA1C_CODE]],
  [CMS122_QUALIFYING_VISIT_OIDS[0]!, [OFFICE_VISIT_CODE]],
  [CMS122_HOSPICE_OID, [{ code: "183919006", system: "http://snomed.info/sct" }]],
  [CMS122_PALLIATIVE_OID, [{ code: "103735009", system: "http://snomed.info/sct" }]],
]);

function cms122Bundle(externalId: string, today = "2026-06-30") {
  const employee = EMPLOYEES.find((e) => e.externalId === externalId)!;
  const binding = MEASURE_BINDINGS["cms122"]!;
  const target = seededTargetFor(EMPLOYEES, binding.rateKey, externalId) ?? "MISSING_DATA";
  const config = deriveExamConfig(binding, target);
  return { employee, base: buildSyntheticBundle(employee, config, today) };
}

test("enrichment appends the diabetes VSAC coding without removing the urn:workwell coding", () => {
  const { employee, base } = cms122Bundle(EMPLOYEES[0]!.externalId);
  const enriched = enrichForOfficialCms122(structuredClone(base), employee, EXPANSIONS, "2026-06-30");
  const conds = (enriched.entry as Array<{ resource: { resourceType: string; code?: { coding: Array<{ system: string; code: string }> } } }>)
    .filter((e) => e.resource.resourceType === "Condition");
  const diabetes = conds.find((c) => c.resource.code?.coding.some((x) => x.system === "urn:workwell:vs:cms122-diabetes"));
  assert.ok(diabetes, "cms122 base bundle must carry the urn:workwell diabetes Condition");
  assert.ok(diabetes.resource.code!.coding.some((x) => x.system === DIABETES_CODE.system && x.code === DIABETES_CODE.code));
});

test("ADR-008 guard: WorkWell cms122 outcome is byte-identical on enriched vs un-enriched bundle", async () => {
  const engine = new CqlExecutionEngine();
  for (const emp of EMPLOYEES.slice(0, 30)) {
    const { employee, base } = cms122Bundle(emp.externalId);
    const enriched = enrichForOfficialCms122(structuredClone(base), employee, EXPANSIONS, "2026-06-30");
    const a = await engine.evaluate({ measureId: "cms122", patientBundle: base, evaluationDate: "2026-06-30" });
    const b = await engine.evaluate({ measureId: "cms122", patientBundle: enriched, evaluationDate: "2026-06-30" });
    assert.equal(b.outcome, a.outcome, `WorkWell cms122 outcome changed by enrichment for ${emp.externalId}`);
  }
});
