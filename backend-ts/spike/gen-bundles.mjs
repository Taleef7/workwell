/**
 * Generate FHIR R4 bundles for all 12 runnable measures × 4 scenarios (#106).
 * Each measure's inline-code bindings (system = valueSet URN, code = code) are
 * embedded below (from the measure YAMLs). Writes:
 *   spike/synthetic/<measureId>/<scenario>.json
 *   spike/synthetic/_index.json   (measureId → ELM library file + scenarios)
 *
 *   node spike/gen-bundles.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "synthetic");
const EVAL = "2026-06-12";
const evalMs = Date.parse(`${EVAL}T00:00:00.000Z`);
const daysAgo = (d) => new Date(evalMs - d * 86_400_000).toISOString();

// system = the valueSet URN, code = the code (matches each measure's inline filters).
const MEASURES = [
  { id: "audiogram", lib: "AnnualAudiogramCompleted-1.0.0", enroll: ["urn:workwell:vs:hearing-enrollment", "hearing-enrollment"], waiver: ["urn:workwell:vs:audiogram-waiver", "audiogram-waiver"], event: ["urn:workwell:vs:audiogram-procedures", "audiogram-procedure", "procedure"] },
  { id: "hazwoper", lib: "HazwoperSurveillance-1.0.0", enroll: ["urn:workwell:vs:hazwoper-enrollment", "hazwoper-program"], waiver: ["urn:workwell:vs:hazwoper-exemption", "hazwoper-exemption"], event: ["urn:workwell:vs:hazwoper-exams", "hazwoper-exam", "procedure"] },
  { id: "tb_surveillance", lib: "TbSurveillance-1.3.0", enroll: ["urn:workwell:vs:tb-eligible-roles", "tb-program"], waiver: ["urn:workwell:vs:tb-exemption", "tb-exemption"], event: ["urn:workwell:vs:tb-screening", "tb-screen", "procedure"] },
  { id: "flu_vaccine", lib: "FluVaccineSeasonal-1.0.0", enroll: ["urn:workwell:vs:clinical-roles", "clinical-role"], waiver: ["urn:workwell:vs:flu-exemption", "flu-exemption"], event: ["urn:workwell:vs:flu-vaccines", "flu-vaccine", "immunization"] },
  { id: "hypertension", lib: "HypertensionBPScreeningCQL-1.0.0", enroll: ["urn:workwell:vs:wellness-enrollment", "wellness-enrolled"], waiver: ["urn:workwell:vs:wellness-exemption", "wellness-exempt"], event: ["urn:workwell:vs:bp-screening", "bp-screen", "procedure"] },
  { id: "diabetes_hba1c", lib: "DiabetesHbA1cMonitoringCQL-1.0.0", enroll: ["urn:workwell:vs:diabetes-program", "diabetes-enrolled"], waiver: ["urn:workwell:vs:diabetes-exemption", "diabetes-exempt"], event: ["urn:workwell:vs:hba1c-labs", "hba1c-lab", "procedure"] },
  { id: "obesity_bmi", lib: "ObesityBMIScreeningCQL-1.0.0", enroll: ["urn:workwell:vs:wellness-enrollment", "wellness-enrolled"], waiver: ["urn:workwell:vs:wellness-exemption", "wellness-exempt"], event: ["urn:workwell:vs:bmi-screening", "bmi-screen", "procedure"] },
  { id: "cholesterol_ldl", lib: "CholesterolLDLScreeningCQL-1.0.0", enroll: ["urn:workwell:vs:cholesterol-program", "cholesterol-enrolled"], waiver: ["urn:workwell:vs:cholesterol-exemption", "cholesterol-exempt"], event: ["urn:workwell:vs:ldl-labs", "ldl-lab", "procedure"] },
  { id: "cms125", lib: "BreastCancerScreeningCQL-1.0.0", enroll: ["urn:workwell:vs:cms125-eligible", "cms125-eligible"], waiver: ["urn:workwell:vs:cms125-excluded", "cms125-excluded"], event: ["urn:workwell:vs:cms125-mammogram", "mammogram", "procedure"] },
  { id: "cms122", lib: "DiabetesHbA1cPoorControlCQL-1.0.0", enroll: ["urn:workwell:vs:cms122-diabetes", "cms122-diabetes"], waiver: ["urn:workwell:vs:cms122-excluded", "cms122-excluded"], event: ["urn:workwell:vs:cms122-hba1c", "hba1c-obs", "observation"] },
  // oldDays override: Td/Tdap window is 10 years (3650 days); 3800 puts "present_old" clearly past it (default 900 would be COMPLIANT here).
  { id: "adult_immunization", lib: "AdultImmunizationTdap-1.0.0", enroll: ["urn:workwell:vs:adult-immz-enrollment", "adult-immz-enrolled"], waiver: ["urn:workwell:vs:tdap-contraindication", "tdap-contraindication"], event: ["urn:workwell:vs:tdap-vaccines", "tdap-vaccine", "immunization"], oldDays: 3800 },
];

const SCENARIOS = ["present_recent", "present_old", "missing", "excluded"];

const coding = ([system, code]) => ({ coding: [{ system, code }] });
const condition = (pid, vsCode, idSuffix) => ({
  resourceType: "Condition", id: `${pid}-${idSuffix}`,
  subject: { reference: `Patient/${pid}` }, code: coding(vsCode),
});

function eventResource(pid, m, whenIso, hba1cValue) {
  const [system, code, type] = m.event;
  if (type === "immunization")
    return { resourceType: "Immunization", id: `${pid}-evt`, status: "completed", patient: { reference: `Patient/${pid}` }, vaccineCode: { coding: [{ system, code }] }, occurrenceDateTime: whenIso };
  if (type === "observation")
    return { resourceType: "Observation", id: `${pid}-evt`, status: "final", subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] }, effectiveDateTime: whenIso, valueQuantity: { value: hba1cValue, unit: "%", system: "http://unitsofmeasure.org", code: "%" } };
  return { resourceType: "Procedure", id: `${pid}-evt`, status: "completed", subject: { reference: `Patient/${pid}` }, code: { coding: [{ system, code }] }, performedDateTime: whenIso };
}

function bundle(m, scenario) {
  const pid = `${m.id}-${scenario}`;
  const entries = [{ resource: { resourceType: "Patient", id: pid } }];
  entries.push({ resource: condition(pid, m.enroll, "enr") });
  if (scenario === "excluded") entries.push({ resource: condition(pid, m.waiver, "wvr") });
  if (scenario === "present_recent") entries.push({ resource: eventResource(pid, m, daysAgo(50), 7.5) });
  if (scenario === "present_old") entries.push({ resource: eventResource(pid, m, daysAgo(m.oldDays ?? 900), 10.5) });
  if (scenario === "excluded") entries.push({ resource: eventResource(pid, m, daysAgo(50), 7.5) });
  return { resourceType: "Bundle", type: "collection", entry: entries };
}

rmSync(root, { recursive: true, force: true });
const index = { evalDate: EVAL, measures: [] };
for (const m of MEASURES) {
  const dir = path.join(root, m.id);
  mkdirSync(dir, { recursive: true });
  for (const s of SCENARIOS) writeFileSync(path.join(dir, `${s}.json`), JSON.stringify(bundle(m, s), null, 2) + "\n");
  index.measures.push({ id: m.id, lib: m.lib, scenarios: SCENARIOS });
}
writeFileSync(path.join(root, "_index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`wrote ${MEASURES.length} measures × ${SCENARIOS.length} scenarios → ${root}`);
