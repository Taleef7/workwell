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

export interface PopulationCounts {
  ipp: number;
  denom: number;
  denex: number;
  numer: number;
  /** Denominator exceptions (CMS68-class). Absent from authored measures; always present as a number. */
  denexcep: number;
}

const zeroCounts = (): PopulationCounts => ({ ipp: 0, denom: 0, denex: 0, numer: 0, denexcep: 0 });

const missingDataMeansOutOfPopulation = (measureId: string): boolean =>
  MEASURE_BINDINGS[measureId]?.missingDataMeansOutOfPopulation === true;

/**
 * Per-subject population membership as the measure's own logic reported it (roadmap §7.3).
 * Official-routed outcomes persist `evidence_json.official.populationResults`; that IS the regulatory
 * truth and must win over any status heuristic, because the 5-bucket `OutcomeStatus` is a *workflow*
 * vocabulary that deliberately cannot express DENEXCEP/NUMEX, and for an inverse measure (cms122:
 * numerator = poor control) the workflow status is the opposite of numerator membership.
 */
export interface PopulationMembership {
  ipp: boolean; denom: boolean; denex: boolean; numer: boolean; denexcep: boolean;
}

const bool = (v: unknown): boolean => v === true;

/**
 * Read official population membership off an outcome's evidence, or `null` when this outcome was not
 * produced by the official executor (every authored measure today). Deliberately tolerant: evidence is
 * persisted JSON, and a malformed payload must degrade to the authored rule rather than throw inside an
 * export.
 */
export function officialMembership(evidence: unknown): PopulationMembership | null {
  const official = (evidence as { official?: { populationResults?: unknown } } | null | undefined)?.official;
  const results = official?.populationResults;
  if (!results || typeof results !== "object" || Array.isArray(results)) return null;
  const r = results as Record<string, unknown>;
  if (typeof r["ipp"] !== "boolean") return null; // not the shape we write — fall back.
  return {
    ipp: bool(r["ipp"]),
    denom: bool(r["denom"]),
    denex: bool(r["denex"]),
    numer: bool(r["numer"]),
    denexcep: bool(r["denexcep"]),
  };
}

/**
 * Membership for one outcome: official evidence first, else the authored status rule (ADR-031) —
 * unchanged for every measure that has no official evidence, which today is all of them.
 */
export function membershipFor(outcome: Pick<OutcomeRecord, "status" | "evidence">, measureId: string): PopulationMembership {
  const official = officialMembership(outcome.evidence);
  if (official) return official;
  if (missingDataMeansOutOfPopulation(measureId) && outcome.status === "MISSING_DATA") {
    return { ipp: false, denom: false, denex: false, numer: false, denexcep: false };
  }
  return {
    ipp: true,
    denom: true,
    denex: outcome.status === "EXCLUDED",
    numer: outcome.status === "COMPLIANT",
    denexcep: false,
  };
}

/** Reduce outcome buckets to proportion-population membership-label counts (the reconciliation contract). */
export function countPopulations(outcomes: OutcomeRecord[], measureId: string): PopulationCounts {
  return outcomes.reduce((counts, outcome) => {
    const m = membershipFor(outcome, measureId);
    if (!m.ipp) return counts;
    counts.ipp += 1;
    if (m.denom) counts.denom += 1;
    if (m.denex) counts.denex += 1;
    if (m.numer) counts.numer += 1;
    if (m.denexcep) counts.denexcep += 1;
    return counts;
  }, zeroCounts());
}

/**
 * The same proportion counts derived from a bounded `GROUP BY status` histogram instead of the
 * per-subject rows (Fable H4) — so the summary MeasureReport + QRDA can be built for a 120k `seed:scale`
 * run without materializing its 1.68M rows. Reconciles 1:1 with {@link countPopulations}.
 *
 * **Scope limit (PR-3).** A status histogram carries no per-subject evidence, so this path cannot see
 * `evidence_json.official.populationResults` and is therefore valid ONLY for authored measures — which
 * is exactly what it is used for: `seed:scale` is synthetic demo data and is never official-routed.
 * If an official-routed run ever needs a bounded summary, the histogram must be widened to group by
 * population membership, not status; do not silently reuse this. A guard test pins the reconciliation
 * for authored measures so the two paths cannot drift apart unnoticed.
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
  // Emitted only when the measure actually has exceptions, so every authored measure's report is
  // byte-identical to before this change.
  ...(c.denexcep > 0 ? [pop("denominator-exception", c.denexcep)] : []),
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
  // eCQM proportion score: exceptions are removed from the denominator alongside exclusions.
  // `denexcep` is 0 for every authored measure, so this is arithmetically unchanged for them.
  const effectiveDenominator = c.denom - c.denex - c.denexcep;
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

/** One subject's membership as 0/1 counts — the individual report is the same reduction over n=1. */
const asCounts = (m: PopulationMembership): PopulationCounts =>
  m.ipp
    ? {
        ipp: 1,
        denom: m.denom ? 1 : 0,
        denex: m.denex ? 1 : 0,
        numer: m.numer ? 1 : 0,
        denexcep: m.denexcep ? 1 : 0,
      }
    : zeroCounts();

export function buildIndividualMeasureReport(
  outcome: OutcomeRecord,
  run: RunRecord,
  measureId: string,
  generatedAt: string,
): MeasureReport {
  const c = asCounts(membershipFor(outcome, measureId));
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
