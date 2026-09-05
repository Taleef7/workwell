/**
 * QI-Core bundle shapes for the three official-only measures — cms2 (depression screening
 * and follow-up), cms130 (colorectal cancer screening) and cms165 (controlling high blood
 * pressure) — the substance of Task 3 / spec §4.1.
 *
 * ## Why these are not part of `fhir-bundle-builder.ts`
 *
 * The authored cms122/cms125 path is driven by `MEASURE_BINDINGS` — each measure's config names a
 * code and a value set, and the builder stamps whatever it is handed. The official-only measures have
 * no binding row and no authored CQL: the official artifacts ARE the measure. Their shapes are written
 * directly against the artifact's ELM (value-set OIDs, profile stamps, age gates), so they belong in a
 * file of their own rather than inside the binding-driven builder.
 *
 * ## QI-Core profile stamping is load-bearing
 *
 * The official artifacts retrieve through QI-Core profiles. A resource carrying the WRONG profile
 * stamp (or none) is silently never retrieved — the measure just reports nobody in the population.
 * The profiles below were read from each artifact's own `dataRequirement.profile` entries:
 *
 * - cms2 screening Observation → `qicore-observation-screening-assessment` (NOT the generic
 *   `qicore-observation-clinical-result` used elsewhere in this package)
 * - cms2 bipolar Condition → `qicore-condition-problems-health-concerns`
 * - cms130 colonoscopy → `qicore-procedure`
 * - cms130 colorectal cancer → `qicore-condition-problems-health-concerns`
 * - cms165 hypertension / ESRD → `qicore-condition-problems-health-concerns`
 * - cms165 BP panel → `us-core-blood-pressure` (a US Core profile, NOT QI-Core)
 * - every Encounter → `qicore-encounter`
 */
import type { EmployeeProfile } from "./employee-catalog.ts";
import type { TargetOutcome } from "./exam-config.ts";
import type { FhirBundle } from "./fhir-bundle-builder.ts";
import { ECQM_CANONICAL_CODES } from "../cql/bundled-ecqm-expansions.ts";

const CPT = "http://www.ama-assn.org/go/cpt";

export type OfficialOnlyMeasureId = "cms2" | "cms130" | "cms165";

export const OFFICIAL_ONLY_MEASURE_IDS: readonly OfficialOnlyMeasureId[] = [
  "cms2",
  "cms130",
  "cms165",
] as const;

/**
 * What CQL is expected to say for each seeded bucket — pinned so a drift is a test failure, not a
 * surprise. `target` is a synthetic-data distribution BUCKET, never a decision: the bundle for
 * COMPLIANT carries the clinical facts (a negative screen, a colonoscopy, a controlled BP reading)
 * that make the measure's own logic conclude compliance.
 */
export const OFFICIAL_ONLY_CONVERGENCE: Record<
  OfficialOnlyMeasureId,
  Record<TargetOutcome, "COMPLIANT" | "OVERDUE" | "EXCLUDED">
> = {
  cms2: { COMPLIANT: "COMPLIANT", OVERDUE: "OVERDUE", EXCLUDED: "EXCLUDED", MISSING_DATA: "OVERDUE", DUE_SOON: "OVERDUE" },
  cms130: { COMPLIANT: "COMPLIANT", OVERDUE: "OVERDUE", EXCLUDED: "EXCLUDED", MISSING_DATA: "OVERDUE", DUE_SOON: "OVERDUE" },
  cms165: { COMPLIANT: "COMPLIANT", OVERDUE: "OVERDUE", EXCLUDED: "EXCLUDED", MISSING_DATA: "OVERDUE", DUE_SOON: "OVERDUE" },
};

const QICORE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";
const USCORE = "http://hl7.org/fhir/us/core/StructureDefinition/";

/** evaluationDate is "YYYY-MM-DD"; returns the FHIR dateTime `daysAgo` before it. */
function dateMinusDays(evaluationDate: string, daysAgo: number): string {
  const d = new Date(`${evaluationDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.toISOString().slice(0, 10)}T00:00:00`;
}

/** Birth date for the eCQM age gates (eval year derived from evaluationDate). */
function ecqmBirthDate(evaluationDate: string, ageAtEnd: number): string {
  const year = Number(evaluationDate.slice(0, 4)) - ageAtEnd;
  return `${year}-06-15`;
}

function patient(e: EmployeeProfile, birthDate: string): unknown {
  return {
    resourceType: "Patient",
    meta: { profile: [`${QICORE}qicore-patient`] },
    id: e.externalId,
    name: [{ text: e.name }],
    birthDate,
  };
}

function officeVisit(e: EmployeeProfile, evaluationDate: string, daysAgo: number): unknown {
  const day = dateMinusDays(evaluationDate, daysAgo).slice(0, 10);
  return {
    resourceType: "Encounter",
    meta: { profile: [`${QICORE}qicore-encounter`] },
    id: `${e.externalId}-office-visit`,
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${e.externalId}` },
    type: [{ coding: [ECQM_CANONICAL_CODES.officeVisit] }],
    period: { start: `${day}T09:00:00`, end: `${day}T09:30:00` },
  };
}

interface Coding {
  system: string;
  code: string;
  display?: string;
}

function condition(
  e: EmployeeProfile,
  suffix: string,
  codings: Coding[],
  evaluationDate: string,
  profile: "problems-health-concerns" | "encounter-diagnosis" = "problems-health-concerns",
): unknown {
  return {
    resourceType: "Condition",
    meta: { profile: [`${QICORE}qicore-condition-${profile}`] },
    id: `${e.externalId}-${suffix}`,
    subject: { reference: `Patient/${e.externalId}` },
    onsetDateTime: dateMinusDays(evaluationDate, 730),
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
    },
    code: { coding: codings },
  };
}

// ── cms2: Depression Screening and Follow-Up ─────────────────────────────────────

/**
 * Birth date → age 40 at period end: inside the adult band (17+) and well clear of the adolescent
 * boundary (12–16), so the artifact's adult instrument (LOINC 73832-8) is unambiguously the one that
 * fires. The COMPLIANT shape emits the screening Observation with a NEGATIVE result — the numerator's
 * "negative result" branch. The OVERDUE shape emits a POSITIVE result with no follow-up, which is the
 * numerator's "positive with follow-up" branch not firing. EXCLUDED adds the bipolar Condition, which
 * is the artifact's denominator-exclusion set.
 */
function cms2(e: EmployeeProfile, target: TargetOutcome, evaluationDate: string): FhirBundle {
  const birthDate = ecqmBirthDate(evaluationDate, 40);
  const visit = officeVisit(e, evaluationDate, 60);
  const visitDay = dateMinusDays(evaluationDate, 60).slice(0, 10);
  const entries: Array<{ resource: unknown }> = [{ resource: patient(e, birthDate) }, { resource: visit }];

  if (target === "EXCLUDED") {
    entries.push({
      resource: condition(e, "bipolar", [ECQM_CANONICAL_CODES.bipolarDisorder], evaluationDate),
    });
  }

  if (target === "COMPLIANT" || target === "OVERDUE" || target === "EXCLUDED") {
    entries.push({
      resource: {
        resourceType: "Observation",
        meta: { profile: [`${QICORE}qicore-observation-screening-assessment`] },
        id: `${e.externalId}-depression-screen`,
        status: "final",
        subject: { reference: `Patient/${e.externalId}` },
        code: { coding: [ECQM_CANONICAL_CODES.depressionScreenAdult] },
        effectiveDateTime: visitDay,
        valueCodeableConcept: {
          coding:
            target === "OVERDUE"
              ? [ECQM_CANONICAL_CODES.depressionScreenPositive]
              : [ECQM_CANONICAL_CODES.depressionScreenNegative],
        },
      },
    });
  }

  // MISSING_DATA / DUE_SOON: in IPP (age + visit) but no screening Observation — converges to OVERDUE.
  return { resourceType: "Bundle", type: "collection", entry: entries };
}

// ── cms130: Colorectal Cancer Screening ──────────────────────────────────────────

/**
 * Birth date → age 60 at period end: inside the 46–75 band with margin on both sides. The COMPLIANT
 * shape uses colonoscopy, dated 3 y before the evaluation date — inside the artifact's 10-year
 * colonoscopy window. The shape only uses one of the five screening modalities (the plan's
 * modality-boundary tests are out of scope for the base shape; see spec §4.1).
 */
function cms130(e: EmployeeProfile, target: TargetOutcome, evaluationDate: string): FhirBundle {
  const birthDate = ecqmBirthDate(evaluationDate, 60);
  const visit = officeVisit(e, evaluationDate, 60);
  const entries: Array<{ resource: unknown }> = [{ resource: patient(e, birthDate) }, { resource: visit }];

  if (target === "EXCLUDED") {
    entries.push({
      resource: condition(e, "colorectal-cancer", [ECQM_CANONICAL_CODES.colorectalCancer], evaluationDate),
    });
  }

  if (target === "COMPLIANT") {
    entries.push({
      resource: {
        resourceType: "Procedure",
        meta: { profile: [`${QICORE}qicore-procedure`] },
        id: `${e.externalId}-colonoscopy`,
        status: "completed",
        subject: { reference: `Patient/${e.externalId}` },
        code: { coding: [ECQM_CANONICAL_CODES.colonoscopy] },
        performedDateTime: dateMinusDays(evaluationDate, 365 * 3),
      },
    });
  }

  // OVERDUE / MISSING_DATA / DUE_SOON: in IPP (age + visit) but no screening — converges to OVERDUE.
  return { resourceType: "Bundle", type: "collection", entry: entries };
}

// ── cms165: Controlling High Blood Pressure ──────────────────────────────────────

/**
 * Birth date → age 55 at period end: inside the 18–85 band. The hypertension Condition is present on
 * every target with an onset well before the period start, which is what makes the subject a
 * denominator member. The BP panel is the US Core `us-core-blood-pressure` profile — the artifact's
 * `Status.isObservationBP` requires `status = final` and a `vital-signs` category alongside the
 * profile stamp, so all three are emitted. The panel code LOINC 85354-9 and the component codes
 * 8480-6 / 8462-4 are direct-reference LOINC codes in the artifact's CQL, not value-set members.
 */
function cms165(e: EmployeeProfile, target: TargetOutcome, evaluationDate: string): FhirBundle {
  const birthDate = ecqmBirthDate(evaluationDate, 55);
  const visit = officeVisit(e, evaluationDate, 60);
  const entries: Array<{ resource: unknown }> = [{ resource: patient(e, birthDate) }, { resource: visit }];

  if (target === "EXCLUDED") {
    entries.push({
      resource: condition(e, "esrd", [ECQM_CANONICAL_CODES.esrd], evaluationDate),
    });
  }

  entries.push({
    resource: condition(e, "htn", [ECQM_CANONICAL_CODES.essentialHypertension], evaluationDate),
  });

  if (target === "COMPLIANT" || target === "OVERDUE" || target === "EXCLUDED") {
    entries.push({
      resource: {
        resourceType: "Observation",
        meta: { profile: [`${USCORE}us-core-blood-pressure`] },
        id: `${e.externalId}-bp-panel`,
        status: "final",
        category: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/observation-category",
                code: "vital-signs",
              },
            ],
          },
        ],
        subject: { reference: `Patient/${e.externalId}` },
        code: { coding: [ECQM_CANONICAL_CODES.bpPanel] },
        effectiveDateTime: dateMinusDays(evaluationDate, 60),
        component: [
          {
            code: { coding: [ECQM_CANONICAL_CODES.bpSystolic] },
            valueQuantity: { value: target === "OVERDUE" ? 152 : 128, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
          },
          {
            code: { coding: [ECQM_CANONICAL_CODES.bpDiastolic] },
            valueQuantity: { value: target === "OVERDUE" ? 94 : 78, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
          },
        ],
      },
    });
  }

  // MISSING_DATA / DUE_SOON: in IPP (age + HTN dx + visit) but no BP reading — converges to OVERDUE.
  return { resourceType: "Bundle", type: "collection", entry: entries };
}

export function buildOfficialOnlyBundle(
  e: EmployeeProfile,
  measureId: OfficialOnlyMeasureId,
  target: TargetOutcome,
  evaluationDate: string,
): FhirBundle {
  switch (measureId) {
    case "cms2":
      return cms2(e, target, evaluationDate);
    case "cms130":
      return cms130(e, target, evaluationDate);
    case "cms165":
      return cms165(e, target, evaluationDate);
  }
}
