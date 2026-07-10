/**
 * E14 PR-2 (#186) — outcome-diff: estimates, criterion by criterion, how many subjects
 * from the latest CMS122 population run would diverge if the official eCQM criteria
 * (OMITTED/SIMPLIFIED in WorkWell's authored measure) were applied. Descriptive only —
 * never affects a compliance outcome (ADR-008).
 *
 * Not a full CQL re-execution: a full outcome diff requires the official VSAC value sets
 * via the ValueSetResolver port (deferred until VSAC credentials are available). Instead
 * this is a criteria-impact analysis: for verifiable criteria (age gate — synthetic
 * patients have deterministic birthDates), count divergent subjects; for unverifiable
 * criteria (encounters, hospice, frailty, palliative — absent from synthetic bundles),
 * report why verification is impossible.
 */
import type { Coverage, OfficialMeasureReference, Population } from "./reference-types.ts";

export interface CriterionImpact {
  /** Matches `key` from the official reference criterion. */
  key: string;
  population: Population;
  coverage: Coverage;
  /** Whether this criterion can be evaluated against synthetic patient data. */
  verifiable: boolean;
  /** Subjects whose WorkWell outcome would change if this criterion were applied. 0 when unverifiable. */
  subjectsAffected: number;
  /** For unverifiable criteria: the synthetic-data gap that prevents evaluation. */
  reason?: string;
  /** Sourced note from the official reference. */
  note: string;
}

export interface OutcomeDiffReport {
  /** Diff-mode tier (#258): the PR-2 criteria-impact estimate. See literal → subset → estimate ladder. */
  mode: "estimate";
  measureId: string;
  ecqmId: string;
  /** The population run this diff is based on, or null when no run exists yet. */
  runId: string | null;
  /** ISO date (YYYY-MM-DD) of the population run, or null when no run exists yet. */
  asOf: string | null;
  totalSubjectsEvaluated: number;
  /** Sum of `subjectsAffected` across all verifiable OMITTED/SIMPLIFIED criteria. */
  totalDivergent: number;
  criterionImpacts: CriterionImpact[];
  headline: string;
  disclaimer: string;
}

// --- implementation ----------------------------------------------------------------

const DISCLAIMER =
  "Criteria-impact analysis: estimates how many evaluated subjects would have different outcomes " +
  "if the official eCQM criteria omitted or simplified by WorkWell's authored measure were applied. " +
  "Unverifiable criteria lack the required clinical data in the synthetic dataset. This is descriptive — " +
  "CQL Outcome Status remains the sole compliance authority (ADR-008). A full outcome diff (executing the " +
  "official CQL with real VSAC value sets) requires the ValueSetResolver port once VSAC credentials are available.";

/**
 * Same hash formula as fhir-bundle-builder.ts `birthDate()`. Duplicated here (not imported)
 * to keep the standards module free of engine/synthetic dependencies.
 * Formula: `1980 + (hash(externalId) % 20)` → birth years 1980–1999 → ages 27–46 in 2026.
 */
function syntheticBirthYear(externalId: string): number {
  let h = 0;
  for (const ch of externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 1980 + (h % 20);
}

function ageAt(externalId: string, evalYear: number): number {
  return evalYear - syntheticBirthYear(externalId);
}

/**
 * Per-criterion evaluator: returns true when the subject WOULD diverge (i.e. the official
 * criterion, if applied, would change their outcome from what WorkWell computed).
 */
type CriterionEvaluator = (subjectId: string, currentStatus: string, evalYear: number) => boolean;

const EVALUATORS: Partial<Record<string, CriterionEvaluator>> = {
  "age-18-75": (subjectId, _status, evalYear) => {
    const age = ageAt(subjectId, evalYear);
    return age < 18 || age > 75;
  },
};

const UNVERIFIABLE_REASONS: Partial<Record<string, string>> = {
  "qualifying-visit":
    "Synthetic FHIR bundles include no Encounter resources — the official qualifying-visit gate cannot be evaluated.",
  "hospice":
    "Synthetic FHIR bundles include no hospice Encounter or Service Request resources.",
  "long-term-care-66":
    "Synthetic FHIR bundles include no Housing Status Assessment (LOINC 71802-3) resources.",
  "advanced-illness-frailty-66":
    "Synthetic FHIR bundles include no frailty Diagnosis, Device, Encounter, or Symptom resources.",
  "palliative-care":
    "Synthetic FHIR bundles include no palliative-care Encounter, Diagnosis, or Intervention resources.",
  "denominator-equals-ipp":
    "Denominator-equals-IPP simplification impact depends on the IPP gate divergence (age + visit), which is partially unverifiable.",
};

type OutcomeSlice = {
  subjectId: string;
  status: string;
  runId: string;
  runStartedAt: string;
};

/**
 * Compute a criteria-impact diff report for `ref` against `outcomes` (the latest population run's
 * rows for the measure, already filtered to a single run by the caller). `evalYear` defaults to the
 * current UTC year; pass a fixed value in tests for deterministic output.
 */
export function computeOutcomeDiff(
  ref: OfficialMeasureReference,
  outcomes: OutcomeSlice[],
  evalYear: number = new Date().getUTCFullYear(),
): OutcomeDiffReport {
  const runId = outcomes[0]?.runId ?? null;
  const asOf = outcomes[0]?.runStartedAt?.slice(0, 10) ?? null;
  let totalDivergent = 0;

  const criterionImpacts: CriterionImpact[] = ref.criteria.map((c) => {
    if (c.coverage === "COVERED") {
      return {
        key: c.key,
        population: c.population,
        coverage: c.coverage,
        verifiable: true,
        subjectsAffected: 0,
        note: c.note,
      };
    }

    const evaluator = EVALUATORS[c.key];
    if (!evaluator) {
      const reason =
        UNVERIFIABLE_REASONS[c.key] ?? "No synthetic clinical data available for this criterion.";
      return {
        key: c.key,
        population: c.population,
        coverage: c.coverage,
        verifiable: false,
        subjectsAffected: 0,
        reason,
        note: c.note,
      };
    }

    const affected = outcomes.filter((o) => evaluator(o.subjectId, o.status, evalYear)).length;
    totalDivergent += affected;
    return {
      key: c.key,
      population: c.population,
      coverage: c.coverage,
      verifiable: true,
      subjectsAffected: affected,
      note: c.note,
    };
  });

  const verifiableCount = criterionImpacts.filter((c) => c.verifiable).length;
  const unverifiableCount = criterionImpacts.filter((c) => !c.verifiable).length;

  const headline =
    `Of ${outcomes.length} subjects in the latest ${ref.measureId} population run, ` +
    `${totalDivergent} diverge on the ${verifiableCount} verifiable official ${ref.ecqmId} criteria; ` +
    `${unverifiableCount} criteria are unverifiable with synthetic data ` +
    `(encounter, hospice, frailty, and palliative-care records absent).`;

  return {
    mode: "estimate",
    measureId: ref.measureId,
    ecqmId: ref.ecqmId,
    runId,
    asOf,
    totalSubjectsEvaluated: outcomes.length,
    totalDivergent,
    criterionImpacts,
    headline,
    disclaimer: DISCLAIMER,
  };
}
