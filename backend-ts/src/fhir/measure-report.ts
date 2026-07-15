/**
 * FHIR R4 MeasureReport builders (#89 / E3.1) — JVM-free, no FHIR runtime. Turns a completed run's
 * persisted outcomes into the standard eCQM result artifact (summary + per-subject individual +
 * a collection Bundle). Proportion model; counts reconcile 1:1 with `outcomes` by construction:
 *   DENOM is the membership-label count (including DENEX); exclusions subtract only for the score.
 * CMS122/CMS125 additionally map MISSING_DATA out of IPP/DENOM because their authored CQL uses that
 * outcome for `not Initial Population` (binding-driven; OSHA/HEDIS MISSING_DATA stays in-population).
 */
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord, OutcomeStatusCount } from "../stores/outcome-store.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";

const POP_SYSTEM = "http://terminology.hl7.org/CodeSystem/measure-population";
const IMPROVEMENT_SYSTEM = "http://terminology.hl7.org/CodeSystem/measure-improvement-notation";

export interface Population {
  code: { coding: Array<{ system: string; code: string }> };
  count: number;
}
export interface MeasureReport {
  resourceType: "MeasureReport";
  id: string;
  status: "complete";
  type: "summary" | "individual";
  measure: string;
  contained: Array<{ resourceType: "Organization"; id: string; name: string }>;
  subject?: { reference: string };
  date: string;
  reporter: { reference: string };
  period: { start: string; end: string };
  improvementNotation?: { coding: Array<{ system: string; code: string }> };
  group: Array<{ population: Population[]; measureScore?: { value: number } }>;
}
/** A `collection` Bundle: entry[0] is the summary report; the rest are per-subject individuals. */
export interface MeasureReportBundle {
  resourceType: "Bundle";
  type: "collection";
  entry: Array<{ fullUrl: string; resource: MeasureReport }>;
}

export interface PopulationCounts { ipp: number; denom: number; denex: number; numer: number; }

const zeroCounts = (): PopulationCounts => ({ ipp: 0, denom: 0, denex: 0, numer: 0 });

const missingDataMeansOutOfPopulation = (measureId: string): boolean =>
  MEASURE_BINDINGS[measureId]?.missingDataMeansOutOfPopulation === true;

/** Reduce outcome buckets to proportion-population membership-label counts (the reconciliation contract). */
export function countPopulations(outcomes: OutcomeRecord[], measureId: string): PopulationCounts {
  const missingIsOut = missingDataMeansOutOfPopulation(measureId);
  return outcomes.reduce((counts, outcome) => {
    if (missingIsOut && outcome.status === "MISSING_DATA") return counts;
    counts.ipp += 1;
    counts.denom += 1;
    if (outcome.status === "EXCLUDED") counts.denex += 1;
    if (outcome.status === "COMPLIANT") counts.numer += 1;
    return counts;
  }, zeroCounts());
}

/**
 * The same proportion counts derived from a bounded `GROUP BY status` histogram instead of the
 * per-subject rows (Fable H4) — so the summary MeasureReport + QRDA can be built for a 120k `seed:scale`
 * run without materializing its 1.68M rows. Reconciles 1:1 with {@link countPopulations}.
 */
export function populationCountsFromStatus(counts: OutcomeStatusCount[], measureId: string): PopulationCounts {
  const missingIsOut = missingDataMeansOutOfPopulation(measureId);
  return counts.reduce((population, bucket) => {
    if (missingIsOut && bucket.status === "MISSING_DATA") return population;
    population.ipp += bucket.count;
    population.denom += bucket.count;
    if (bucket.status === "EXCLUDED") population.denex += bucket.count;
    if (bucket.status === "COMPLIANT") population.numer += bucket.count;
    return population;
  }, zeroCounts());
}

// WorkWell's numerator is compliance-oriented (including inverted CMS122 logic), so this MUST remain
// the WorkWell canonical. Switching to an official CMS canonical is forbidden unless the numerator
// orientation and improvementNotation are changed together to match that official Measure.
const measureCanonical = (measureId: string): string => `urn:workwell:measure:${measureId}`;

const improvementNotation = (measureId: string): "increase" | "decrease" =>
  MEASURE_BINDINGS[measureId]?.improvementNotation ?? "increase";

const REPORTER_ID = "workwell-measure-studio";
const reportMetadata = (generatedAt: string) => ({
  id: crypto.randomUUID(),
  date: generatedAt,
  contained: [{ resourceType: "Organization" as const, id: REPORTER_ID, name: "WorkWell Measure Studio" }],
  reporter: { reference: `#${REPORTER_ID}` },
});

const pop = (code: string, count: number): Population => ({ code: { coding: [{ system: POP_SYSTEM, code }] }, count });

const populations = (c: PopulationCounts): Population[] => [
  pop("initial-population", c.ipp),
  pop("numerator", c.numer),
  pop("denominator", c.denom),
  pop("denominator-exclusion", c.denex),
];

export function buildSummaryMeasureReport(
  run: RunRecord,
  measureId: string,
  outcomes: OutcomeRecord[],
  generatedAt: string,
): MeasureReport {
  return buildSummaryMeasureReportFromCounts(run, measureId, countPopulations(outcomes, measureId), generatedAt);
}

/** Summary MeasureReport from pre-aggregated counts (the bounded Fable H4 path). */
export function buildSummaryMeasureReportFromCounts(
  run: RunRecord,
  measureId: string,
  c: PopulationCounts,
  generatedAt: string,
): MeasureReport {
  const group: MeasureReport["group"][number] = { population: populations(c) };
  const effectiveDenominator = c.denom - c.denex;
  if (effectiveDenominator > 0) group.measureScore = { value: c.numer / effectiveDenominator };
  return {
    resourceType: "MeasureReport",
    ...reportMetadata(generatedAt),
    status: "complete",
    type: "summary",
    measure: measureCanonical(measureId),
    period: { start: run.measurementPeriodStart, end: run.measurementPeriodEnd },
    improvementNotation: { coding: [{ system: IMPROVEMENT_SYSTEM, code: improvementNotation(measureId) }] },
    group: [group],
  };
}

/** Per-subject population membership (0/1). Unknown statuses fall back to a denominator gap. */
const MEMBERSHIP: Record<string, PopulationCounts> = {
  COMPLIANT: { ipp: 1, denom: 1, denex: 0, numer: 1 },
  DUE_SOON: { ipp: 1, denom: 1, denex: 0, numer: 0 },
  OVERDUE: { ipp: 1, denom: 1, denex: 0, numer: 0 },
  MISSING_DATA: { ipp: 1, denom: 1, denex: 0, numer: 0 },
  EXCLUDED: { ipp: 1, denom: 1, denex: 1, numer: 0 },
};

export function buildIndividualMeasureReport(
  outcome: OutcomeRecord,
  run: RunRecord,
  measureId: string,
  generatedAt: string,
): MeasureReport {
  const c = missingDataMeansOutOfPopulation(measureId) && outcome.status === "MISSING_DATA"
    ? zeroCounts()
    : MEMBERSHIP[outcome.status] ?? { ipp: 1, denom: 1, denex: 0, numer: 0 };
  return {
    resourceType: "MeasureReport",
    ...reportMetadata(generatedAt),
    status: "complete",
    type: "individual",
    measure: measureCanonical(measureId),
    // subjectId is the employee external id (used as the Patient ref); fhir_patient_id linkage is deferred (spec §7).
    subject: { reference: `Patient/${outcome.subjectId}` },
    period: { start: run.measurementPeriodStart, end: run.measurementPeriodEnd },
    improvementNotation: { coding: [{ system: IMPROVEMENT_SYSTEM, code: improvementNotation(measureId) }] },
    group: [{ population: populations(c) }],
  };
}

export function buildMeasureReportBundle(
  run: RunRecord,
  measureId: string,
  outcomes: OutcomeRecord[],
  generatedAt: string,
): MeasureReportBundle {
  const reports = [
    buildSummaryMeasureReport(run, measureId, outcomes, generatedAt),
    ...outcomes.map((outcome) => buildIndividualMeasureReport(outcome, run, measureId, generatedAt)),
  ];
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: reports.map((resource) => ({ fullUrl: `urn:uuid:${resource.id}`, resource })),
  };
}
