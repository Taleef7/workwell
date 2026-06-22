/**
 * Synthetic FHIR R4 bundle builder (#107 run pipeline) — TS port of
 * com.workwell.compile.SyntheticFhirBundleBuilder, emitting plain FHIR JSON (consumed
 * by cql-exec-fhir) instead of HAPI objects.
 *
 * Builds the transient evaluation input for one employee: a Patient, an optional
 * enrollment Condition, an optional waiver/exemption Condition, and the qualifying event
 * (Procedure | Immunization | Observation) stamped with the measure's code/value-set so
 * the CQL inline code filters match (see docs/MEASURES.md "Implementation Notes"). The
 * bundle is never persisted — it exists only to feed the engine.
 */
import type { EmployeeProfile } from "./employee-catalog.ts";
import type { ExamConfig } from "./exam-config.ts";

const QICORE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";
const QICORE_PROFILES = {
  Patient: `${QICORE}qicore-patient`,
  Condition: `${QICORE}qicore-condition`,
  Procedure: `${QICORE}qicore-procedure`,
  Immunization: `${QICORE}qicore-immunization`,
  Observation: `${QICORE}qicore-observation-clinical-result`,
} as const;

/** evaluationDate is "YYYY-MM-DD"; returns the FHIR dateTime `daysAgo` before it. */
function dateMinusDays(evaluationDate: string, daysAgo: number): string {
  const d = new Date(`${evaluationDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.toISOString().slice(0, 10)}T00:00:00`;
}

/** Deterministic, outcome-irrelevant birth year (the CQL doesn't use age for these measures). */
function birthDate(externalId: string): string {
  let h = 0;
  for (const ch of externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${1980 + (h % 20)}-01-01`;
}

function condition(externalId: string, code: string, valueSet: string): unknown {
  return {
    resourceType: "Condition",
    meta: { profile: [QICORE_PROFILES.Condition] },
    id: `${externalId}-${code}`,
    subject: { reference: `Patient/${externalId}` },
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
    },
    code: { coding: [{ system: valueSet, code, display: code }] },
  };
}

export interface FhirBundle {
  resourceType: "Bundle";
  type: "collection";
  entry: Array<{ resource: unknown }>;
}

export function buildSyntheticBundle(employee: EmployeeProfile, config: ExamConfig, evaluationDate: string): FhirBundle {
  const { externalId } = employee;
  const { binding } = config;
  const entries: Array<{ resource: unknown }> = [
    {
      resource: {
        resourceType: "Patient",
        meta: { profile: [QICORE_PROFILES.Patient] },
        id: externalId,
        name: [{ text: employee.name }],
        birthDate: birthDate(externalId),
      },
    },
  ];

  if (config.programEnrolled) {
    entries.push({ resource: condition(externalId, binding.enrollment.code, binding.enrollment.valueSet) });
  }
  if (config.hasWaiver) {
    entries.push({ resource: condition(externalId, binding.waiver.code, binding.waiver.valueSet) });
  }
  if (config.refused && binding.refusal) {
    entries.push({ resource: condition(externalId, binding.refusal.code, binding.refusal.valueSet) });
  }

  const coding = { system: binding.event.valueSet, code: binding.event.code, display: binding.event.code };

  if (config.observationValue !== null) {
    entries.push({
      resource: {
        resourceType: "Observation",
        meta: { profile: [QICORE_PROFILES.Observation] },
        id: `${externalId}-observation`,
        status: "final",
        subject: { reference: `Patient/${externalId}` },
        code: { coding: [coding] },
        ...(config.daysSinceLastExam !== null ? { effectiveDateTime: dateMinusDays(evaluationDate, config.daysSinceLastExam) } : {}),
        valueQuantity: { value: config.observationValue, unit: "%", system: "http://unitsofmeasure.org", code: "%" },
      },
    });
  } else if (config.daysSinceLastExam !== null) {
    const when = dateMinusDays(evaluationDate, config.daysSinceLastExam);
    if (binding.event.type === "immunization") {
      const doses = config.doseCount ?? 1;
      for (let i = 0; i < doses; i++) {
        // Stagger doses ~60 days apart, anchored at `when` (oldest dose first).
        const doseWhen = dateMinusDays(evaluationDate, config.daysSinceLastExam! + i * 60);
        entries.push({
          resource: {
            resourceType: "Immunization",
            meta: { profile: [QICORE_PROFILES.Immunization] },
            id: `${externalId}-immunization-${i}`,
            status: "completed",
            patient: { reference: `Patient/${externalId}` },
            vaccineCode: { coding: [coding] },
            occurrenceDateTime: doseWhen,
          },
        });
      }
    } else {
      entries.push({
        resource: {
          resourceType: "Procedure",
          meta: { profile: [QICORE_PROFILES.Procedure] },
          id: `${externalId}-procedure`,
          status: "completed",
          subject: { reference: `Patient/${externalId}` },
          code: { coding: [coding] },
          performedDateTime: when,
        },
      });
    }
  }

  return { resourceType: "Bundle", type: "collection", entry: entries };
}
