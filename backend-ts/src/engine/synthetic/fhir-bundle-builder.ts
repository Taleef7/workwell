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
 *
 * CMS122v14 / CMS125v14 (2026-07 production-faithful path): dual-codes real VSAC/LOINC/CPT
 * members alongside legacy urn:workwell:* so eCQI value-set retrieves fire.
 */
import type { EmployeeProfile } from "./employee-catalog.ts";
import type { ExamConfig } from "./exam-config.ts";
import type { MeasureBinding, SeriesAlternativeBinding } from "./measure-bindings.ts";
import { ECQM_CANONICAL_CODES } from "../cql/bundled-ecqm-expansions.ts";

/** Stable per-employee hash → pick one alternative dose series (Hep B Heplisav-vs-traditional). */
function pickAlternative(binding: MeasureBinding, externalId: string): SeriesAlternativeBinding | null {
  const alts = binding.alternatives;
  if (!alts?.length) return null;
  let h = 0;
  for (const ch of externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return alts[h % alts.length]!;
}

const QICORE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";
const QICORE_PROFILES = {
  Patient: `${QICORE}qicore-patient`,
  Condition: `${QICORE}qicore-condition`,
  Procedure: `${QICORE}qicore-procedure`,
  Immunization: `${QICORE}qicore-immunization`,
  Observation: `${QICORE}qicore-observation-clinical-result`,
  Encounter: `${QICORE}qicore-encounter`,
} as const;

/** evaluationDate is "YYYY-MM-DD"; returns the FHIR dateTime `daysAgo` before it. */
function dateMinusDays(evaluationDate: string, daysAgo: number): string {
  const d = new Date(`${evaluationDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.toISOString().slice(0, 10)}T00:00:00`;
}

/** Deterministic birth year — mid-range adult (ages ~26–45 at 2026) for non-eCQM measures. */
function birthDate(externalId: string): string {
  let h = 0;
  for (const ch of externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${1980 + (h % 20)}-01-01`;
}

/** Birth date for eCQM age gates (eval year derived from evaluationDate). */
function ecqmBirthDate(evaluationDate: string, ageAtEnd: number): string {
  const year = Number(evaluationDate.slice(0, 4)) - ageAtEnd;
  return `${year}-06-15`;
}

function condition(
  externalId: string,
  code: string,
  valueSet: string,
  extraCodings: Array<{ system: string; code: string; display?: string }> = [],
): unknown {
  return {
    resourceType: "Condition",
    meta: { profile: [QICORE_PROFILES.Condition] },
    id: `${externalId}-${code}`,
    subject: { reference: `Patient/${externalId}` },
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
    },
    code: {
      coding: [{ system: valueSet, code, display: code }, ...extraCodings],
    },
  };
}

function officeVisit(externalId: string, evaluationDate: string, daysAgo = 90): unknown {
  const day = dateMinusDays(evaluationDate, daysAgo).slice(0, 10);
  return {
    resourceType: "Encounter",
    meta: { profile: [QICORE_PROFILES.Encounter] },
    id: `${externalId}-office-visit`,
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${externalId}` },
    type: [{ coding: [ECQM_CANONICAL_CODES.officeVisit] }],
    period: { start: `${day}T09:00:00`, end: `${day}T09:30:00` },
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

  if (binding.rateKey === "cms122") return buildCms122Bundle(employee, config, evaluationDate);
  if (binding.rateKey === "cms125") return buildCms125Bundle(employee, config, evaluationDate);

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
      const alt = pickAlternative(binding, externalId);
      const required = binding.series?.requiredDoses ?? 1;
      const doses = alt
        ? (config.doseCount ?? 0) >= required
          ? alt.requiredDoses
          : (config.doseCount ?? 0) > 0
            ? Math.max(Math.min(alt.requiredDoses - 1, required - 1), 1)
            : 0
        : config.doseCount ?? 1;
      const doseCoding = alt
        ? { system: binding.event.valueSet, code: alt.codes[0], display: alt.codes[0] }
        : coding;
      for (let i = 0; i < doses; i++) {
        const doseWhen = dateMinusDays(evaluationDate, config.daysSinceLastExam! + i * 60);
        entries.push({
          resource: {
            resourceType: "Immunization",
            meta: { profile: [QICORE_PROFILES.Immunization] },
            id: `${externalId}-immunization-${i}`,
            status: "completed",
            patient: { reference: `Patient/${externalId}` },
            vaccineCode: { coding: [doseCoding] },
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

/** CMS122v14: age 18–75, visit, diabetes dual-code, HbA1c dual-code in MP, hospice/palliative DENEX. */
function buildCms122Bundle(employee: EmployeeProfile, config: ExamConfig, evaluationDate: string): FhirBundle {
  const { externalId } = employee;
  const { binding } = config;
  const entries: Array<{ resource: unknown }> = [
    {
      resource: {
        resourceType: "Patient",
        meta: { profile: [QICORE_PROFILES.Patient] },
        id: externalId,
        name: [{ text: employee.name }],
        // Age 50 at end of MP — squarely in 18–75.
        birthDate: ecqmBirthDate(evaluationDate, 50),
      },
    },
  ];

  // Qualifying visit in the 12-month measurement period (periodMonths=12).
  entries.push({ resource: officeVisit(externalId, evaluationDate, 90) });

  if (config.programEnrolled) {
    entries.push({
      resource: condition(externalId, binding.enrollment.code, binding.enrollment.valueSet, [
        ECQM_CANONICAL_CODES.diabetes,
      ]),
    });
  }

  if (config.hasWaiver) {
    // Map generic waiver → palliative diagnosis (DENEX) with dual coding.
    entries.push({
      resource: condition(externalId, binding.waiver.code, binding.waiver.valueSet, [
        ECQM_CANONICAL_CODES.palliativeDx,
      ]),
    });
  }

  if (config.observationValue !== null) {
    const daysAgo = config.daysSinceLastExam ?? 30;
    entries.push({
      resource: {
        resourceType: "Observation",
        meta: { profile: [QICORE_PROFILES.Observation] },
        id: `${externalId}-hba1c`,
        status: "final",
        subject: { reference: `Patient/${externalId}` },
        code: {
          coding: [
            { system: binding.event.valueSet, code: binding.event.code, display: binding.event.code },
            ECQM_CANONICAL_CODES.hba1c,
          ],
        },
        effectiveDateTime: dateMinusDays(evaluationDate, daysAgo),
        valueQuantity: {
          value: config.observationValue,
          unit: "%",
          system: "http://unitsofmeasure.org",
          code: "%",
        },
      },
    });
  }

  return { resourceType: "Bundle", type: "collection", entry: entries };
}

/**
 * CMS125v14: female 42–74, visit, mammogram in official Oct-1 window (≈27 months),
 * mastectomy/hospice/palliative DENEX. No DUE_SOON — COMPLIANT if numerator else OVERDUE.
 */
function buildCms125Bundle(employee: EmployeeProfile, config: ExamConfig, evaluationDate: string): FhirBundle {
  const { externalId } = employee;
  const { binding } = config;
  const entries: Array<{ resource: unknown }> = [
    {
      resource: {
        resourceType: "Patient",
        meta: { profile: [QICORE_PROFILES.Patient] },
        id: externalId,
        name: [{ text: employee.name }],
        gender: "female",
        // Age 55 — in 42–74 IPP band.
        birthDate: ecqmBirthDate(evaluationDate, 55),
      },
    },
  ];

  entries.push({ resource: officeVisit(externalId, evaluationDate, 60) });

  if (config.hasWaiver) {
    // Generic exclusion → bilateral mastectomy history (DENEX).
    entries.push({
      resource: condition(externalId, binding.waiver.code, binding.waiver.valueSet, [
        ECQM_CANONICAL_CODES.historyBilateralMastectomy,
      ]),
    });
  }

  if (config.daysSinceLastExam !== null) {
    // Stamp mammogram inside the official Oct-1 window (use ~180d before eval — always in-window
    // for a 12-month MP ending on evaluationDate).
    const when = dateMinusDays(evaluationDate, Math.min(config.daysSinceLastExam, 180));
    entries.push({
      resource: {
        resourceType: "Procedure",
        meta: { profile: [QICORE_PROFILES.Procedure] },
        id: `${externalId}-mammogram`,
        status: "completed",
        subject: { reference: `Patient/${externalId}` },
        code: {
          coding: [
            { system: binding.event.valueSet, code: binding.event.code, display: binding.event.code },
            ECQM_CANONICAL_CODES.mammogram,
          ],
        },
        performedDateTime: when,
      },
    });
  }

  // MISSING_DATA / OVERDUE: in IPP (female + age + visit) but no mammogram — daysSinceLastExam null.
  // EXCLUDED: mastectomy condition above, still in IPP.
  return { resourceType: "Bundle", type: "collection", entry: entries };
}
