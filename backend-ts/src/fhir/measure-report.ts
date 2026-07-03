/**
 * FHIR R4 MeasureReport builders (#89 / E3.1) — JVM-free, no FHIR runtime. Turns a completed run's
 * persisted outcomes into the standard eCQM result artifact (summary + per-subject individual +
 * a collection Bundle). Proportion model; counts reconcile 1:1 with `outcomes` by construction:
 *   IPP = all evaluated · DENEX = EXCLUDED · DENOM = IPP − DENEX · NUMER = COMPLIANT · score = NUMER/DENOM.
 */
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord, OutcomeStatusCount } from "../stores/outcome-store.ts";

const POP_SYSTEM = "http://terminology.hl7.org/CodeSystem/measure-population";
const IMPROVEMENT_SYSTEM = "http://terminology.hl7.org/CodeSystem/measure-improvement-notation";

export interface Population {
  code: { coding: Array<{ system: string; code: string }> };
  count: number;
}
export interface MeasureReport {
  resourceType: "MeasureReport";
  status: "complete";
  type: "summary" | "individual";
  measure: string;
  subject?: { reference: string };
  period: { start: string; end: string };
  improvementNotation?: { coding: Array<{ system: string; code: string }> };
  group: Array<{ population: Population[]; measureScore?: { value: number } }>;
}
/** A `collection` Bundle: entry[0] is the summary report; the rest are per-subject individuals. */
export interface MeasureReportBundle {
  resourceType: "Bundle";
  type: "collection";
  entry: Array<{ resource: MeasureReport }>;
}

export interface PopulationCounts { ipp: number; denom: number; denex: number; numer: number; }

/** Reduce outcome buckets to proportion-population counts (the reconciliation contract). */
export function countPopulations(outcomes: OutcomeRecord[]): PopulationCounts {
  const ipp = outcomes.length;
  const denex = outcomes.filter((o) => o.status === "EXCLUDED").length;
  const numer = outcomes.filter((o) => o.status === "COMPLIANT").length;
  return { ipp, denom: ipp - denex, denex, numer };
}

/**
 * The same proportion counts derived from a bounded `GROUP BY status` histogram instead of the
 * per-subject rows (Fable H4) — so the summary MeasureReport + QRDA can be built for a 120k `seed:scale`
 * run without materializing its 1.68M rows. Reconciles 1:1 with {@link countPopulations}.
 */
export function populationCountsFromStatus(counts: OutcomeStatusCount[]): PopulationCounts {
  const by = (status: string) => counts.find((c) => c.status === status)?.count ?? 0;
  const ipp = counts.reduce((sum, c) => sum + c.count, 0);
  const denex = by("EXCLUDED");
  const numer = by("COMPLIANT");
  return { ipp, denom: ipp - denex, denex, numer };
}

const measureCanonical = (measureId: string): string => `urn:workwell:measure:${measureId}`;

const pop = (code: string, count: number): Population => ({ code: { coding: [{ system: POP_SYSTEM, code }] }, count });

const populations = (c: PopulationCounts): Population[] => [
  pop("initial-population", c.ipp),
  pop("numerator", c.numer),
  pop("denominator", c.denom),
  pop("denominator-exclusion", c.denex),
];

export function buildSummaryMeasureReport(run: RunRecord, measureId: string, outcomes: OutcomeRecord[]): MeasureReport {
  return buildSummaryMeasureReportFromCounts(run, measureId, countPopulations(outcomes));
}

/** Summary MeasureReport from pre-aggregated counts (the bounded Fable H4 path). */
export function buildSummaryMeasureReportFromCounts(run: RunRecord, measureId: string, c: PopulationCounts): MeasureReport {
  const group: MeasureReport["group"][number] = { population: populations(c) };
  if (c.denom > 0) group.measureScore = { value: c.numer / c.denom };
  return {
    resourceType: "MeasureReport",
    status: "complete",
    type: "summary",
    measure: measureCanonical(measureId),
    period: { start: run.measurementPeriodStart, end: run.measurementPeriodEnd },
    improvementNotation: { coding: [{ system: IMPROVEMENT_SYSTEM, code: "increase" }] },
    group: [group],
  };
}

/** Per-subject population membership (0/1). Unknown statuses fall back to a denominator gap. */
const MEMBERSHIP: Record<string, PopulationCounts> = {
  COMPLIANT: { ipp: 1, denom: 1, denex: 0, numer: 1 },
  DUE_SOON: { ipp: 1, denom: 1, denex: 0, numer: 0 },
  OVERDUE: { ipp: 1, denom: 1, denex: 0, numer: 0 },
  MISSING_DATA: { ipp: 1, denom: 1, denex: 0, numer: 0 },
  EXCLUDED: { ipp: 1, denom: 0, denex: 1, numer: 0 },
};

export function buildIndividualMeasureReport(outcome: OutcomeRecord, run: RunRecord, measureId: string): MeasureReport {
  const c = MEMBERSHIP[outcome.status] ?? { ipp: 1, denom: 1, denex: 0, numer: 0 };
  return {
    resourceType: "MeasureReport",
    status: "complete",
    type: "individual",
    measure: measureCanonical(measureId),
    // subjectId is the employee external id (used as the Patient ref); fhir_patient_id linkage is deferred (spec §7).
    subject: { reference: `Patient/${outcome.subjectId}` },
    period: { start: run.measurementPeriodStart, end: run.measurementPeriodEnd },
    group: [{ population: populations(c) }],
  };
}

export function buildMeasureReportBundle(run: RunRecord, measureId: string, outcomes: OutcomeRecord[]): MeasureReportBundle {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: buildSummaryMeasureReport(run, measureId, outcomes) },
      ...outcomes.map((o) => ({ resource: buildIndividualMeasureReport(o, run, measureId) })),
    ],
  };
}
