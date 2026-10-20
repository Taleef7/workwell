/**
 * Whether a run's ingested data is complete enough to trust its measures (#853, decision D12).
 *
 * When the data is thin, a measure quietly scores low and the run still says COMPLETED: an encounter whose
 * visit type is text and not a code never qualifies, a blood pressure that is not `final` is never read. So
 * before a run scores live data it measures how much of that data is coded, and a measure whose inputs fall
 * below a floor is marked `data_insufficient`: the run is PARTIAL_FAILURE, the measure closes no case as out
 * of population, and the reports refuse it.
 *
 * What it measures, and what it never measures:
 * - **The share of what was ingested that is usable**, over the whole ingested history. Never "how many
 *   patients have something in the period": on 1 January that is legitimately near zero.
 * - **Nothing about a previous run.** A comparison across a change of measurement year would fire on every
 *   reset.
 * - **A metric with nothing to measure never fires.** No encounters means no encounter floor, so an empty
 *   tenant is judged by the other checks (and by the run's own refusal of an unreadable roster).
 *
 * The floors are starting guesses (D12): they hold until a real-data baseline replaces them.
 */
import { isBloodPressure } from "../wiring/qicore-preparation.ts";

export const DATA_SUFFICIENCY_FLOORS = {
  /** The share of encounters whose `type` is coded (a coding with a system and a code). At least this. */
  encounterTypeCoded: 0.95,
  /** The share of blood pressures CMS165 can read whose status is final. At least this. */
  bloodPressureFinal: 0.95,
  /** The share of subjects whose record could not be read. Below this. */
  failedFetches: 0.01,
} as const;

/** The blood-pressure statuses CMS's `Status.isObservationBP` admits. `unknown` is not one. */
const FINAL_BP_STATUSES: ReadonlySet<string> = new Set(["final", "amended", "corrected"]);

/** The one measure whose logic reads blood pressures. */
const BLOOD_PRESSURE_MEASURES: ReadonlySet<string> = new Set(["cms165"]);

export interface SufficiencyMetrics {
  subjects: number;
  failedFetches: number;
  encounters: number;
  encountersWithCodedType: number;
  bloodPressures: number;
  bloodPressuresFinal: number;
}

export type SufficiencyCheck = "encounterTypeCoded" | "bloodPressureFinal" | "failedFetches";

export interface SufficiencyShortfall {
  check: SufficiencyCheck;
  /** The observed share, 0..1. */
  observed: number;
  floor: number;
  count: number;
  of: number;
}

export interface MeasureSufficiency {
  measureId: string;
  shortfalls: SufficiencyShortfall[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resourcesOf(bundle: unknown): Record<string, unknown>[] {
  if (!isObject(bundle) || !Array.isArray(bundle.entry)) return [];
  return bundle.entry.map((entry) => (isObject(entry) ? entry.resource : undefined)).filter(isObject);
}

function hasCodedType(encounter: Record<string, unknown>): boolean {
  if (!Array.isArray(encounter.type)) return false;
  return encounter.type.some(
    (concept) =>
      isObject(concept) &&
      Array.isArray(concept.coding) &&
      concept.coding.some(
        (coding) =>
          isObject(coding) &&
          typeof coding.system === "string" && coding.system.trim() !== "" &&
          typeof coding.code === "string" && coding.code.trim() !== "",
      ),
  );
}

/**
 * Count, over the bundles a run ingested, what the floors judge. `fetchFailed` names a bundle that stands
 * in for a record that could not be read; its resources are not counted, since there are none of its own.
 */
export function countSufficiency(bundles: readonly unknown[], fetchFailed: (bundle: unknown) => boolean): SufficiencyMetrics {
  const metrics: SufficiencyMetrics = {
    subjects: 0,
    failedFetches: 0,
    encounters: 0,
    encountersWithCodedType: 0,
    bloodPressures: 0,
    bloodPressuresFinal: 0,
  };
  for (const bundle of bundles) {
    metrics.subjects += 1;
    if (fetchFailed(bundle)) {
      metrics.failedFetches += 1;
      continue;
    }
    for (const resource of resourcesOf(bundle)) {
      if (resource.resourceType === "Encounter") {
        metrics.encounters += 1;
        if (hasCodedType(resource)) metrics.encountersWithCodedType += 1;
      } else if (resource.resourceType === "Observation" && isBloodPressure(resource)) {
        metrics.bloodPressures += 1;
        if (typeof resource.status === "string" && FINAL_BP_STATUSES.has(resource.status)) metrics.bloodPressuresFinal += 1;
      }
    }
  }
  return metrics;
}

const share = (count: number, of: number): number => (of === 0 ? 1 : count / of);

/**
 * The measures whose data falls below a floor, each with what fell short. `fqmScored` says whether CMS's
 * logic (or a translation of it) scores the measure: the encounter and blood-pressure floors judge what that
 * logic reads, so a WorkWell-authored measure, which reads neither the same way, is judged only on failed
 * fetches. Our authored CMS165 accepts an `unknown` blood-pressure status, which CMS's does not.
 */
export function judgeSufficiency(
  metrics: SufficiencyMetrics,
  measures: ReadonlyArray<{ measureId: string; fqmScored: boolean }>,
): MeasureSufficiency[] {
  const failed: SufficiencyShortfall | null =
    metrics.subjects > 0 && metrics.failedFetches / metrics.subjects >= DATA_SUFFICIENCY_FLOORS.failedFetches
      ? {
          check: "failedFetches",
          observed: metrics.failedFetches / metrics.subjects,
          floor: DATA_SUFFICIENCY_FLOORS.failedFetches,
          count: metrics.failedFetches,
          of: metrics.subjects,
        }
      : null;
  const encounterShare = share(metrics.encountersWithCodedType, metrics.encounters);
  const uncodedEncounters: SufficiencyShortfall | null =
    metrics.encounters > 0 && encounterShare < DATA_SUFFICIENCY_FLOORS.encounterTypeCoded
      ? {
          check: "encounterTypeCoded",
          observed: encounterShare,
          floor: DATA_SUFFICIENCY_FLOORS.encounterTypeCoded,
          count: metrics.encountersWithCodedType,
          of: metrics.encounters,
        }
      : null;
  const bpShare = share(metrics.bloodPressuresFinal, metrics.bloodPressures);
  const unfinalBloodPressures: SufficiencyShortfall | null =
    metrics.bloodPressures > 0 && bpShare < DATA_SUFFICIENCY_FLOORS.bloodPressureFinal
      ? {
          check: "bloodPressureFinal",
          observed: bpShare,
          floor: DATA_SUFFICIENCY_FLOORS.bloodPressureFinal,
          count: metrics.bloodPressuresFinal,
          of: metrics.bloodPressures,
        }
      : null;

  const verdicts: MeasureSufficiency[] = [];
  for (const { measureId, fqmScored } of measures) {
    const shortfalls: SufficiencyShortfall[] = [];
    if (failed) shortfalls.push(failed);
    if (fqmScored && uncodedEncounters) shortfalls.push(uncodedEncounters);
    if (fqmScored && unfinalBloodPressures && BLOOD_PRESSURE_MEASURES.has(measureId)) shortfalls.push(unfinalBloodPressures);
    if (shortfalls.length > 0) verdicts.push({ measureId, shortfalls });
  }
  return verdicts;
}

/** "encounter types coded: 11 of 89 (12.4%), floor 95%" — for a run log or a refusal body. */
export function describeShortfall(s: SufficiencyShortfall): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const label =
    s.check === "encounterTypeCoded" ? "encounter types coded"
    : s.check === "bloodPressureFinal" ? "blood pressures final"
    : "records that could not be read";
  const relation = s.check === "failedFetches" ? "limit below" : "floor";
  return `${label}: ${s.count} of ${s.of} (${pct(s.observed)}), ${relation} ${pct(s.floor)}`;
}

/**
 * The evidence key a flagged measure's every outcome carries, so a report can refuse from the rows alone. A
 * lost audit write cannot then let a thin run's rates out. Set or removed on EVERY row: a copied-forward row
 * must not keep a flag from an earlier run, nor lose one this run raised.
 */
export function withSufficiency(evidence: unknown, checks: readonly SufficiencyCheck[] | undefined): unknown {
  if (!isObject(evidence)) return evidence;
  if (checks && checks.length > 0) return { ...evidence, dataInsufficient: { checks: [...checks] } };
  if (!("dataInsufficient" in evidence)) return evidence;
  const { dataInsufficient: _dropped, ...rest } = evidence;
  return rest;
}

/** The checks an outcome's evidence says its measure failed, or null when it carries none. */
export function dataInsufficientChecks(evidence: unknown): SufficiencyCheck[] | null {
  if (!isObject(evidence) || !isObject(evidence.dataInsufficient)) return null;
  const checks = evidence.dataInsufficient.checks;
  return Array.isArray(checks) ? checks.filter((c): c is SufficiencyCheck => typeof c === "string") : [];
}
