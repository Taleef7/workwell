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
 * Kept OUT of `normalize` and OUT of a generic PatientDataSource decorator (roster assumptions must not
 * silently leak into every evaluation) — it's a per-bundle pre-evaluation transform applied only through
 * `evaluateSourceWithRoster`. Idempotent; no I/O; no schema; no deps. Descriptive only (ADR-008): it adds
 * a Condition the CQL reads, it never sets an `Outcome Status`.
 *
 * Note on semantics: the roster expresses OH *program* membership. A measure whose "enrollment" is really
 * a clinical Condition (e.g. `cms122`'s diabetes diagnosis) should be satisfied by real WebChart clinical
 * data, not by listing the subject in this roster — so keep such measures out of a roster.
 */
import type { FhirBundle } from "../../synthetic/fhir-bundle-builder.ts";
import { MEASURE_BINDINGS } from "../../synthetic/measure-bindings.ts";
import { evaluateBatch, type BatchResult, type EvaluateBundleOptions } from "../evaluate-bundle.ts";
import type { PatientDataSource } from "../data-source.ts";

/** subjectId → the set of measure-ids that subject is enrolled in (an OH program roster). */
export type EnrollmentRoster = ReadonlyMap<string, ReadonlySet<string>>;

const QICORE_CONDITION = "http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-condition";

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

/**
 * Pure, measure-scoped transform: if the bundle's subject is enrolled in `measureId` per the roster,
 * append the measure's enrollment `Condition`. No-op (returns the input bundle) when the measure is
 * unknown or not a roster-eligible OH-program measure (see `ROSTER_ELIGIBLE_MEASURES` — e.g. cms122's
 * diabetes-diagnosis enrollment is never fabricated), the bundle has no Patient, the subject isn't
 * enrolled, or the Condition is already present (byte-identical idempotency). Never mutates the input.
 */
export function stampEnrollment(bundle: FhirBundle, measureId: string, roster: EnrollmentRoster): FhirBundle {
  const binding = MEASURE_BINDINGS[measureId];
  // Only stamp measures whose enrollment is true program/eligibility membership — never a clinical
  // diagnosis (e.g. cms122's diabetes dx). Fail-closed: an unknown or non-eligible measure is a no-op.
  if (!binding || !ROSTER_ELIGIBLE_MEASURES.has(measureId)) return bundle;
  const subjectId = subjectIdOf(bundle);
  if (!subjectId || !isEnrolled(roster, subjectId, measureId)) return bundle;
  const { code, valueSet } = binding.enrollment;
  if (hasEnrollmentCondition(bundle, valueSet, code)) return bundle;
  return { ...bundle, entry: [...bundle.entry, { resource: enrollmentCondition(subjectId, code, valueSet) }] };
}

/**
 * Roster-aware evaluate: load a source's bundles, stamp each with the measure's enrollment Condition
 * per the roster, then evaluate against the measure. The thin pre-evaluation seam that makes real
 * WebChart data (which lacks OH enrollment) evaluate to real buckets. Unknown-measure fail-fast is
 * inherited from `evaluateBatch`. Non-bundle items pass through unstamped (per-item isolation stays with
 * `evaluateBatch`).
 */
export async function evaluateSourceWithRoster(
  source: PatientDataSource,
  measureId: string,
  roster: EnrollmentRoster,
  opts?: EvaluateBundleOptions,
): Promise<BatchResult> {
  const bundles = (await source.loadBundles()).map((b) =>
    isFhirBundle(b) ? stampEnrollment(b, measureId, roster) : b,
  );
  return evaluateBatch(bundles, measureId, opts);
}
