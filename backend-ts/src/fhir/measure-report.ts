/**
 * FHIR R4 MeasureReport builders (#89 / E3.1) — JVM-free, no FHIR runtime. Turns a completed run's
 * persisted outcomes into the standard eCQM result artifact (summary + per-subject individual +
 * a collection Bundle). Proportion model; counts reconcile 1:1 with `outcomes` by construction:
 *   IPP = all evaluated · DENEX = EXCLUDED · DENOM = IPP − DENEX · NUMER = COMPLIANT · score = NUMER/DENOM.
 */
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

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

const measureCanonical = (measureId: string): string => `urn:workwell:measure:${measureId}`;

const pop = (code: string, count: number): Population => ({ code: { coding: [{ system: POP_SYSTEM, code }] }, count });

const populations = (c: PopulationCounts): Population[] => [
  pop("initial-population", c.ipp),
  pop("numerator", c.numer),
  pop("denominator", c.denom),
  pop("denominator-exclusion", c.denex),
];

export function buildSummaryMeasureReport(run: RunRecord, measureId: string, outcomes: OutcomeRecord[]): MeasureReport {
  const c = countPopulations(outcomes);
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
