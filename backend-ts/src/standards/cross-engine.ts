/**
 * The cross-engine comparison, extracted from `scripts/cross-engine-check.ts` so the part that decides
 * "do the two engines agree on this case" is a pure function with a test (MM-1 U3, ADR-074).
 *
 * It reads EVERY group of both MeasureReports. The script compared `group[0]` of each, which for a
 * single-rate measure is the whole answer and for CMS137 is Initiation alone — an Engagement
 * disagreement, the rate the measure exists to surface, read as agreement. The counts come from
 * `populationCountsByRate`, which zero-initialises every gated population (the zeroes are load-bearing:
 * a report that omits DENEXCEP must compare as 0, not as "unknown"), and the verdict is the SAME shared
 * classifier the MADiE gate uses, so the two cannot drift.
 */
import {
  classifyPopulationAgreement,
  populationCountsByRate,
  type FhirResource,
  type OfficialMeasureId,
  type PopulationAgreement,
  type PopulationCounts,
} from "./official-cases.ts";

export interface CrossEngineComparison {
  /** Every rate of the steward's expected report, in `Measure.group` order. */
  readonly expected: PopulationCounts[];
  /** Every rate of the second engine's report, in the same order. */
  readonly actual: PopulationCounts[];
  readonly agreement: PopulationAgreement;
}

export function compareReports(
  measure: OfficialMeasureId,
  caseName: string,
  expectedReport: unknown,
  actualReport: unknown,
): CrossEngineComparison {
  const expected = populationCountsByRate(expectedReport as FhirResource);
  const actual = populationCountsByRate(actualReport as FhirResource);
  const multiRate = expected.length > 1 || actual.length > 1;
  const agreement = classifyPopulationAgreement(
    measure,
    caseName,
    expected[0]!,
    actual[0]!,
    multiRate ? { expected, actual } : undefined,
  );
  return { expected, actual, agreement };
}

/**
 * The degenerate-sweep signal, over every rate: a sweep in which the second engine put nobody in any
 * population of any rate is terminology or libraries failing to resolve, not agreement.
 */
export function allZeroAcrossRates(rates: readonly PopulationCounts[]): boolean {
  return rates.every((counts) => Object.values(counts).every((value) => value === 0));
}
