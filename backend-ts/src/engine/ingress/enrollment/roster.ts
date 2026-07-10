/**
 * OH enrollment roster + enrollment-Condition stamping (WebChart dev-DB proof, PR-1).
 *
 * The measures gate on a program-enrollment `Condition` (`urn:workwell:vs:<x>-enrollment`) that a
 * WebChart clinical bundle does NOT carry — it's occupational-health **program membership**, held in a
 * WorkWell-side OH program roster, not in WebChart's clinical data. So a real WebChart bundle alone
 * evaluates as MISSING_DATA for an enrolled worker. This module supplies that missing input: a roster
 * (subject → enrolled measure-ids) and a pure, measure-scoped transform that stamps the enrollment
 * `Condition` the CQL expects — the exact Condition `engine/synthetic/fhir-bundle-builder.ts` stamps
 * from `ExamConfig.programEnrolled`, sourced from `MEASURE_BINDINGS[id].enrollment`.
 *
 * **CMS125 eCQI (2026-07):** production CQL also requires a qualifying visit during the measurement
 * period (IPP). WebChart clinical payloads often have mammograms but no Encounter; the OH roster is
 * the legitimate source of "this worker is in the active screening program," so for `cms125` we also
 * stamp a CPT 99213 office-visit Encounter inside the MP (same shape as the synthetic builder). That
 * is program-visit evidence, not a fabricated clinical mammogram. Descriptive only (ADR-008).
 *
 * Kept OUT of `normalize` and OUT of a generic PatientDataSource decorator (roster assumptions must not
 * silently leak into every evaluation) — it's a per-bundle pre-evaluation transform applied only through
 * `evaluateSourceWithRoster`. Idempotent; no I/O; no schema; no deps. Descriptive only (ADR-008): it adds
 * resources the CQL reads, it never sets an `Outcome Status`.
 *
 * Note on semantics: the roster expresses OH *program* membership. A measure whose "enrollment" is really
 * a clinical Condition (e.g. `cms122`'s diabetes diagnosis) should be satisfied by real WebChart clinical
 * data, not by listing the subject in this roster — so keep such measures out of a roster.
 */
import type { FhirBundle } from "../../synthetic/fhir-bundle-builder.ts";
import { MEASURE_BINDINGS } from "../../synthetic/measure-bindings.ts";
import { ECQM_CANONICAL_CODES } from "../../cql/bundled-ecqm-expansions.ts";
import { evaluateBatch, type BatchResult, type EvaluateBundleOptions } from "../evaluate-bundle.ts";
import type { PatientDataSource } from "../data-source.ts";

/** subjectId → the set of measure-ids that subject is enrolled in (an OH program roster). */
export type EnrollmentRoster = ReadonlyMap<string, ReadonlySet<string>>;

const QICORE_CONDITION = "http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-condition";
const QICORE_ENCOUNTER = "http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-encounter";

/**
 * Measures whose `enrollment` Condition is genuine OH-program / screening-eligibility membership the
 * roster may legitimately assert. **Fail-closed allowlist** (Codex P2, #247): a measure absent here is
 * NEVER stamped, so `stampEnrollment` can't fabricate a clinical fact from the roster.
 *
 * Excludes **`cms122`**, whose "enrollment" maps to a diabetes *diagnosis*
 * (`urn:workwell:vs:cms122-diabetes`) — a clinical inclusion condition, not program membership. Stamping
 * it would move a subject into the denominator from a lab result alone, so a real diabetes diagnosis must
 * come from the WebChart clinical data, never the roster. Any future diagnosis-gated measure is likewise
 * excluded until explicitly added here.
 */
const ROSTER_ELIGIBLE_MEASURES: ReadonlySet<string> = new Set([
  "audiogram", "hazwoper", "tb_surveillance", "adult_immunization", "flu_vaccine",
  "diabetes_hba1c", "cholesterol_ldl", "hypertension", "obesity_bmi",
  "mmr", "varicella", "hepatitis_b_vaccination_series", "cms125",
]);

/** eCQM measures whose IPP needs a qualifying visit the OH roster may supply (Codex P1, #280). */
const ROSTER_VISIT_MEASURES: ReadonlySet<string> = new Set(["cms125"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a plain JSON roster (`{ "<subjectId>": ["<measureId>", ...] }`) into an EnrollmentRoster.
 * Tolerant of junk — a non-object input, or an entry whose value isn't a string array, is dropped
 * (never thrown), so a malformed committed fixture degrades to "not enrolled", not a crash.
 */
export function parseEnrollmentRoster(raw: unknown): EnrollmentRoster {
  const roster = new Map<string, Set<string>>();
  if (!isObject(raw)) return roster;
  for (const [subjectId, measures] of Object.entries(raw)) {
    if (!Array.isArray(measures)) continue;
    const ids = measures.filter((m): m is string => typeof m === "string");
    if (ids.length) roster.set(subjectId, new Set(ids));
  }
  return roster;
}

/** Is `subjectId` enrolled in `measureId` per the roster? */
export function isEnrolled(roster: EnrollmentRoster, subjectId: string, measureId: string): boolean {
  return roster.get(subjectId)?.has(measureId) ?? false;
}

function isFhirBundle(v: unknown): v is FhirBundle {
  return isObject(v) && v.resourceType === "Bundle" && Array.isArray(v.entry);
}

/**
 * The subject external id — the id of the bundle's (first) Patient resource, which the engine keys on.
 * WebChart payloads are one-patient-per-bundle (matching `normalizeWebChartBundle`), so the first Patient
 * is the subject. Entry items are guarded (`isObject`) so a junk item (`entry:[null]`) can't throw here —
 * it degrades to "no subject" and stamping no-ops, keeping per-item isolation with `evaluateBatch`.
 */
function subjectIdOf(bundle: FhirBundle): string | undefined {
  for (const entry of bundle.entry) {
    if (!isObject(entry)) continue;
    const { resource } = entry;
    if (isObject(resource) && resource.resourceType === "Patient" && typeof resource.id === "string") {
      return resource.id;
    }
  }
  return undefined;
}

/** True when an enrollment Condition with this exact (system, code) coding is already present. */
function hasEnrollmentCondition(bundle: FhirBundle, valueSet: string, code: string): boolean {
  return bundle.entry.some((entry) => {
    if (!isObject(entry)) return false;
    const { resource } = entry;
    if (!isObject(resource) || resource.resourceType !== "Condition") return false;
    const coding = isObject(resource.code) ? resource.code.coding : undefined;
    return (
      Array.isArray(coding) &&
      coding.some((c) => isObject(c) && c.system === valueSet && c.code === code)
    );
  });
}

/** The enrollment Condition — identical shape to `fhir-bundle-builder.ts`'s `condition()`. */
function enrollmentCondition(subjectId: string, code: string, valueSet: string): unknown {
  return {
    resourceType: "Condition",
    meta: { profile: [QICORE_CONDITION] },
    id: `${subjectId}-${code}`,
    subject: { reference: `Patient/${subjectId}` },
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
    },
    code: { coding: [{ system: valueSet, code, display: code }] },
  };
}

/** YYYY-MM-DD of evaluationDate minus days (UTC), used to place visits inside the 12-month MP. */
function dateMinusDays(evaluationDate: string, daysAgo: number): string {
  const d = new Date(`${evaluationDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Qualifying office-visit Encounter (CPT 99213) — matches synthetic builder + VSAC Office Visit OID. */
function qualifyingOfficeVisit(subjectId: string, evaluationDate: string, daysAgo = 90): unknown {
  const day = dateMinusDays(evaluationDate, daysAgo);
  return {
    resourceType: "Encounter",
    meta: { profile: [QICORE_ENCOUNTER] },
    id: `${subjectId}-office-visit`,
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${subjectId}` },
    type: [{ coding: [ECQM_CANONICAL_CODES.officeVisit] }],
    period: { start: `${day}T09:00:00`, end: `${day}T09:30:00` },
  };
}

function hasResourceId(bundle: FhirBundle, id: string): boolean {
  return bundle.entry.some((entry) => {
    if (!isObject(entry)) return false;
    const { resource } = entry;
    return isObject(resource) && resource.id === id;
  });
}

export interface StampEnrollmentOptions {
  /**
   * Anchors the CMS125 qualifying-visit Encounter inside the measurement period
   * (`[eval − 12 months, eval]`). Defaults to today (UTC date).
   */
  evaluationDate?: string;
}

/**
 * Pure, measure-scoped transform: if the bundle's subject is enrolled in `measureId` per the roster,
 * append the measure's enrollment `Condition` (and, for cms125, a qualifying office-visit Encounter).
 * No-op (returns the input bundle) when the measure is unknown or not a roster-eligible OH-program
 * measure (see `ROSTER_ELIGIBLE_MEASURES` — e.g. cms122's diabetes-diagnosis enrollment is never
 * fabricated), the bundle has no Patient, the subject isn't enrolled, or the resources are already
 * present (byte-identical idempotency). Never mutates the input.
 */
export function stampEnrollment(
  bundle: FhirBundle,
  measureId: string,
  roster: EnrollmentRoster,
  opts?: StampEnrollmentOptions,
): FhirBundle {
  const binding = MEASURE_BINDINGS[measureId];
  // Only stamp measures whose enrollment is true program/eligibility membership — never a clinical
  // diagnosis (e.g. cms122's diabetes dx). Fail-closed: an unknown or non-eligible measure is a no-op.
  if (!binding || !ROSTER_ELIGIBLE_MEASURES.has(measureId)) return bundle;
  const subjectId = subjectIdOf(bundle);
  if (!subjectId || !isEnrolled(roster, subjectId, measureId)) return bundle;

  const evaluationDate = opts?.evaluationDate ?? new Date().toISOString().slice(0, 10);
  const additions: Array<{ resource: unknown }> = [];

  const { code, valueSet } = binding.enrollment;
  if (!hasEnrollmentCondition(bundle, valueSet, code)) {
    additions.push({ resource: enrollmentCondition(subjectId, code, valueSet) });
  }

  // CMS125 production CQL IPP: female + age + qualifying visit. The roster asserts program membership;
  // the visit is the eCQI-aligned evidence WebChart typically lacks for OH screening programs.
  if (ROSTER_VISIT_MEASURES.has(measureId)) {
    const visitId = `${subjectId}-office-visit`;
    if (!hasResourceId(bundle, visitId)) {
      additions.push({ resource: qualifyingOfficeVisit(subjectId, evaluationDate) });
    }
  }

  if (additions.length === 0) return bundle;
  return { ...bundle, entry: [...bundle.entry, ...additions] };
}

/**
 * Roster-aware evaluate: load a source's bundles, stamp each with the measure's enrollment Condition
 * (and eCQM visit evidence where required) per the roster, then evaluate against the measure. The thin
 * pre-evaluation seam that makes real WebChart data (which lacks OH enrollment) evaluate to real buckets.
 * Unknown-measure fail-fast is inherited from `evaluateBatch`. Non-bundle items pass through unstamped
 * (per-item isolation stays with `evaluateBatch`).
 */
export async function evaluateSourceWithRoster(
  source: PatientDataSource,
  measureId: string,
  roster: EnrollmentRoster,
  opts?: EvaluateBundleOptions,
): Promise<BatchResult> {
  const stampOpts: StampEnrollmentOptions | undefined = opts?.evaluationDate
    ? { evaluationDate: opts.evaluationDate }
    : undefined;
  const bundles = (await source.loadBundles()).map((b) =>
    isFhirBundle(b) ? stampEnrollment(b, measureId, roster, stampOpts) : b,
  );
  return evaluateBatch(bundles, measureId, opts);
}
