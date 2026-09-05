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
import { ECQM_CANONICAL_CODES, MAMMOGRAPHY_PROCEDURE_CPT } from "../cql/bundled-ecqm-expansions.ts";

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

/**
 * A date `daysAgo` before the evaluation date, CLAMPED forward into the calendar measurement period.
 *
 * ADR-072 made an officially-routed measure score over the CALENDAR YEAR containing the evaluation
 * date. Synthetic qualifying encounters are dated relative to the evaluation date, so for any run in
 * the first `daysAgo` days of a year the encounter fell into the PREVIOUS year — outside the period —
 * and every subject dropped out of the initial population. The run still completed and every case read
 * MISSING_DATA, so the roster showed "nobody eligible" rather than an error. With PY2027 beginning
 * 2027-01-01 and Maui running nightly, that is a ~90-day annual window of silently empty numbers on
 * measures a customer reports to their ACO.
 *
 * Clamping forward is safe for the authored path too: the rolling window is `evalDate − 365d …
 * evalDate`, and 1 January of the evaluation year is always inside it.
 *
 * Use this for anything the measure must find INSIDE the period (qualifying encounters, screening
 * results, BP readings). Do NOT use it for facts that legitimately predate the period — a condition
 * onset or a colonoscopy inside a nine-year lookback — which is why `dateMinusDays` stays.
 */
export function dateInMeasurementPeriod(evaluationDate: string, daysAgo: number): string {
  const periodStart = `${evaluationDate.slice(0, 4)}-01-01`;
  const target = dateMinusDays(evaluationDate, daysAgo).slice(0, 10);
  return `${target < periodStart ? periodStart : target}T00:00:00`;
}

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

/**
 * US Core's `us-core-sex` extension, which is what CMS125's official initial population reads.
 *
 * It does NOT read `Patient.gender`, and measuring that was the difference between the whole synthetic
 * roster being in CMS125's initial population and none of it. The authored `cms125` still reads
 * `Patient.gender`, so both are emitted; they are different FHIR elements answering different questions
 * (administrative gender vs recorded sex), and a real US-Core patient carries both.
 */
const US_CORE_SEX_FEMALE = {
  url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex",
  valueCode: "248152002",
};

/**
 * How long before the evaluation date a synthetic Condition is taken to have started.
 *
 * Two years puts every Condition's onset before the start of any measurement period this repo evaluates,
 * so a condition is prevalent throughout — which is what the fiction intends ("this employee has
 * diabetes", not "was diagnosed halfway through the quarter").
 *
 * An onset is REQUIRED, not decorative. Official artifacts date conditions through
 * `QICoreCommon.prevalenceInterval`, and its behaviour with a null onset is not merely
 * conservative — it is inconsistent: CMS122's `prevalenceInterval(diabetes) Overlaps MP` returns true
 * (an unbounded interval overlaps everything), while CMS125's `Start(prevalenceInterval(mastectomy))
 * SameOrBefore End(MP)` returns null, because there is no start to compare. Measured: the synthetic
 * EXCLUDED cohort was scored OVERDUE by the official CMS125 for exactly this reason.
 *
 * This is the corpus AUTHORING a fact about a fictional patient, which is legitimate — and the opposite
 * of `qicore-preparation.ts` inventing an onset for data it was handed, which ADR-037 forbids. The
 * distinction is whose fact it is.
 */
const CONDITION_ONSET_DAYS_BEFORE = 730;

function condition(
  externalId: string,
  code: string,
  valueSet: string,
  evaluationDate: string,
  extraCodings: Array<{ system: string; code: string; display?: string }> = [],
): unknown {
  return {
    resourceType: "Condition",
    meta: { profile: [QICORE_PROFILES.Condition] },
    id: `${externalId}-${code}`,
    subject: { reference: `Patient/${externalId}` },
    onsetDateTime: dateMinusDays(evaluationDate, CONDITION_ONSET_DAYS_BEFORE),
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
  // Must land inside the measurement period, or the measure finds no qualifying encounter.
  const day = dateInMeasurementPeriod(evaluationDate, daysAgo).slice(0, 10);
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
    entries.push({ resource: condition(externalId, binding.enrollment.code, binding.enrollment.valueSet, evaluationDate) });
  }
  if (config.hasWaiver) {
    entries.push({ resource: condition(externalId, binding.waiver.code, binding.waiver.valueSet, evaluationDate) });
  }
  if (config.refused && binding.refusal) {
    entries.push({ resource: condition(externalId, binding.refusal.code, binding.refusal.valueSet, evaluationDate) });
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
      resource: condition(externalId, binding.enrollment.code, binding.enrollment.valueSet, evaluationDate, [
        ECQM_CANONICAL_CODES.diabetes,
      ]),
    });
  }

  if (config.hasWaiver) {
    // Map generic waiver → palliative diagnosis (DENEX) with dual coding.
    entries.push({
      resource: condition(externalId, binding.waiver.code, binding.waiver.valueSet, evaluationDate, [
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
        extension: [US_CORE_SEX_FEMALE],
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
      resource: condition(externalId, binding.waiver.code, binding.waiver.valueSet, evaluationDate, [
        ECQM_CANONICAL_CODES.historyBilateralMastectomy,
      ]),
    });
  }

  if (config.daysSinceLastExam !== null) {
    // Stamp mammogram inside the official Oct-1 window (use ~180d before eval — always in-window
    // for a 12-month MP ending on evaluationDate).
    const when = dateMinusDays(evaluationDate, Math.min(config.daysSinceLastExam, 180));
    // The PROCEDURE, carrying CPT: what WebChart records and what the authored `cms125` retrieves.
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
            MAMMOGRAPHY_PROCEDURE_CPT,
          ],
        },
        performedDateTime: when,
      },
    });
    // The RESULT, carrying LOINC: what the OFFICIAL numerator retrieves — `[Observation: "Mammography"]`
    // through `Status.isDiagnosticStudyPerformed`, which additionally requires a `final|amended|corrected`
    // status and an `imaging` category. Both representations are real; an EHR that performed a screening
    // mammogram has a procedure record and a result, and the two code systems are not interchangeable
    // (every member of VSAC's Mammography value set is LOINC). Emitting only one of them is what made the
    // official artifact score this corpus as nobody-screened.
    entries.push({
      resource: {
        resourceType: "Observation",
        meta: { profile: [QICORE_PROFILES.Observation] },
        id: `${externalId}-mammogram-result`,
        status: "final",
        category: [
          {
            coding: [
              { system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "imaging" },
            ],
          },
        ],
        subject: { reference: `Patient/${externalId}` },
        code: { coding: [ECQM_CANONICAL_CODES.mammogram] },
        effectiveDateTime: when,
      },
    });
  }

  // MISSING_DATA / OVERDUE: in IPP (female + age + visit) but no mammogram — daysSinceLastExam null.
  // EXCLUDED: mastectomy condition above, still in IPP.
  return { resourceType: "Bundle", type: "collection", entry: entries };
}
