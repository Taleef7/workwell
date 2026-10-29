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

export function compareReports(expectedReport: unknown, actualReport: unknown): CrossEngineComparison {
  const expected = populationCountsByRate(expectedReport as FhirResource);
  const actual = populationCountsByRate(actualReport as FhirResource);
  const multiRate = expected.length > 1 || actual.length > 1;
  const agreement = classifyPopulationAgreement(expected[0]!, actual[0]!, multiRate ? { expected, actual } : undefined);
  return { expected, actual, agreement };
}

/**
 * The second engine's own error, when it answered with a MeasureReport that carries one (#846). cqf-fhir-cr
 * catches an exception inside an evaluation and still returns a MeasureReport: every population 0, the
 * exception in a contained `OperationOutcome`. Compared as counts, that reads as a disagreement about the
 * measure; it is the engine failing on the case's data (CMS165's `45e01fed`, a MedicationRequest whose
 * medication is a Reference: cqframework/clinical-reasoning#1071), so the sweep records it as an engine
 * error instead. Only `error` and `fatal` issues count; a warning beside real counts is still a result.
 */
export function engineErrorOf(report: unknown): string | undefined {
  const contained = (report as { contained?: unknown } | null)?.contained;
  if (!Array.isArray(contained)) return undefined;
  for (const resource of contained as Array<{ resourceType?: unknown; issue?: unknown }>) {
    if (resource?.resourceType !== "OperationOutcome" || !Array.isArray(resource.issue)) continue;
    for (const issue of resource.issue as Array<{ severity?: unknown; diagnostics?: unknown; details?: { text?: unknown } }>) {
      if (issue?.severity !== "error" && issue?.severity !== "fatal") continue;
      const text = issue.details?.text ?? issue.diagnostics;
      return typeof text === "string" && text.length > 0 ? text : `an OperationOutcome ${issue.severity} with no text`;
    }
  }
  return undefined;
}

/**
 * The degenerate-sweep signal, over every rate: a sweep in which the second engine put nobody in any
 * population of any rate is terminology or libraries failing to resolve, not agreement.
 */
export function allZeroAcrossRates(rates: readonly PopulationCounts[]): boolean {
  return rates.every((counts) => Object.values(counts).every((value) => value === 0));
}
