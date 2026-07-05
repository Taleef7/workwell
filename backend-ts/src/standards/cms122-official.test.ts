import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { CMS122_OFFICIAL_META, CMS122_DIABETES_OID, CMS122_HBA1C_OID } from "./cms122-official.ts";
import type { ValueSetResolver } from "../engine/cql/value-set-resolver.ts";

const DIABETES_CODE = { code: "44054006", system: "http://snomed.info/sct" };
const HBA1C_CODE = { code: "4548-4", system: "http://loinc.org" };
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
}): unknown {
  const entry: Array<{ resource: unknown }> = [
    { resource: { resourceType: "Patient", id: "p1", birthDate: parts.birthDate } },
  ];
  if (parts.visit) entry.push({ resource: { resourceType: "Encounter", id: "e1", status: "finished", subject: { reference: "Patient/p1" }, type: [{ coding: [OFFICE_VISIT_CODE] }], period: { start: "2026-03-01T00:00:00" } } });
  if (parts.diabetes) entry.push({ resource: { resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1" }, code: { coding: [DIABETES_CODE] } } });
  if (parts.hba1c != null && parts.hba1c !== "missing") entry.push({ resource: { resourceType: "Observation", id: "o1", status: "final", subject: { reference: "Patient/p1" }, code: { coding: [HBA1C_CODE] }, effectiveDateTime: "2026-04-01T00:00:00", valueQuantity: { value: parts.hba1c, unit: "%", system: "http://unitsofmeasure.org", code: "%" } } });
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
test("official CMS122: in-IPP, HbA1c missing → OVERDUE (missing counts as numerator)", async () => {
  const o = await evalOfficial(bundle({ birthDate: "1980-01-01", visit: true, diabetes: true, hba1c: "missing" }));
  assert.equal(define(o, "HbA1c Missing"), true);
  assert.equal(o.outcome, "OVERDUE");
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
