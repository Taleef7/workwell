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
import { loadOfficialArtifact } from "../wiring/official-artifacts.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";

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
  /** Denominator exceptions (CMS68-class). Always present; `0` for every authored measure. */
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
 * The persisted contract between the official executor (the writer, PR-7) and these exporters (the
 * reader). Both shapes below are accepted so the halves cannot drift:
 *
 *  - the **fqm-native array** `[{ populationType, result }]`, which is what `fqm-execution` hands back
 *    and what `standards/{literal-diff,official-cases}.ts` already work in — the shape the most obvious
 *    writer implementation produces; and
 *  - the **keyed object** `{ ipp, denom, denex, numer, denexcep }`, the compact normalized form.
 */
export type OfficialPopulationResults =
  | Array<{ populationType?: unknown; result?: unknown }>
  | Record<string, unknown>;

/**
 * The raw flags a writer reports, before the CQM IG membership formulas are applied. `numex`
 * (numerator exclusion) exists only at this stage: it folds into `numer` during normalization and is
 * deliberately NOT part of {@link PopulationMembership} — no shipped measure declares one, so
 * reporting a NUMEX population count would be plumbing with no consumer. When a measure with a
 * numerator exclusion ships, widen the public shape then.
 */
interface RawPopulationFlags extends PopulationMembership {
  numex: boolean;
}

/** fqm/FHIR population codes → our membership keys. */
const POPULATION_CODE_TO_KEY: Record<string, keyof RawPopulationFlags> = {
  "initial-population": "ipp",
  denominator: "denom",
  "denominator-exclusion": "denex",
  "denominator-exception": "denexcep",
  numerator: "numer",
  "numerator-exclusion": "numex",
};

/**
 * An `official` block that is present but unreadable is LOUD, not silent (review finding). For a
 * lower-is-better measure the authored fallback is the logical INVERSE of the official numerator
 * (cms122: numerator = poor control), so silently degrading would turn a regulatory artifact into its
 * opposite with no signal. We still do not throw — an export is an on-demand read and must return
 * something — but the greppable alert line the repo already uses for run failures is emitted.
 */
function alertUnreadableOfficialEvidence(reason: string, results: unknown): void {
  console.error(
    `WORKWELL_ALERT ${JSON.stringify({
      kind: "OFFICIAL_POPULATION_RESULTS_UNREADABLE",
      reason,
      received: typeof results === "object" ? Object.keys(results ?? {}).slice(0, 12) : typeof results,
    })}`,
  );
}

/**
 * Two normalization stages with different meanings and different loudness (#476):
 *
 * 1. **Subset clamps, ALERTED** — `numer ⊆ denom ⊆ ipp`, `denex`/`denexcep ⊆ denom`. No spec formula
 *    produces a violation, so one indicates an unreadable writer; violations are clamped and alerted
 *    rather than trusted (an inverted pair would emit a non-conformant MeasureReport that Cypress
 *    would reject).
 *
 * 2. **The CQM IG membership formulas, SILENT** — hl7.fhir.uv.cqm v1.0.0 STU1 (2025-09-11),
 *    measure-conformance.html § "Subject-based Calculation", proportion scoring:
 *
 *      Denominator Membership = IP and Denominator and not DENEX and not (DENEXCEP and not Numerator)
 *      Numerator Membership   = IP and Denominator and not DENEX and Numerator and not NUMEX
 *
 *    Applied per subject so the marginal-count arithmetic downstream is EXACT:
 *    `numer := numer ∧ ¬denex ∧ ¬numex` and `denexcep := denexcep ∧ ¬denex ∧ ¬numer_RAW` (the raw
 *    numerator — the DM formula negates the exception on the criteria result, before NUMEX) make
 *    `denom − denex − denexcep` equal |Denominator Membership| and `numer` equal
 *    |Numerator Membership| by construction, exhaustively verified over all 64 raw flag
 *    combinations — which is what `buildSummaryMeasureReportFromCounts`
 *    and the QRDA III exporter divide. Without the per-subject fold, a DENEXCEP∧NUMER subject is
 *    subtracted from the effective denominator while staying in the numerator (a score above 1.0),
 *    and a NUMEX'd or DENEX'd subject keeps a numerator the spec removes. These folds are spec
 *    application, not corruption repair — a writer that reports raw co-true flags (fqm zeroes some
 *    interactions itself; the reader must not depend on which) is behaving, so no alert.
 *
 *    `cqm-membership-formulas.test.ts` pins the formulas verbatim; a spec revision should fail there.
 */
function normalizeMembership(m: RawPopulationFlags): PopulationMembership {
  const denom = m.denom && m.ipp;
  const subset: PopulationMembership = {
    ipp: m.ipp,
    denom,
    denex: m.denex && denom,
    denexcep: m.denexcep && denom,
    numer: m.numer && denom,
  };
  if (
    subset.ipp !== m.ipp || subset.denom !== m.denom || subset.denex !== m.denex ||
    subset.denexcep !== m.denexcep || subset.numer !== m.numer
  ) {
    alertUnreadableOfficialEvidence("population membership violates numer/denex ⊆ denom ⊆ ipp", m);
  }
  return {
    ipp: subset.ipp,
    denom: subset.denom,
    denex: subset.denex,
    numer: subset.numer && !subset.denex && !m.numex,
    // The RAW (subset-clamped) numerator, NOT the NUMEX-folded one: the IG's Denominator Membership
    // negates the exception on the "Numerator" criteria result, and NUMEX applies only inside
    // Numerator Membership. A DENEXCEP∧NUMER∧NUMEX subject therefore stays in the effective
    // denominator as a scored failure (#484 review, finding 1).
    denexcep: subset.denexcep && !subset.denex && !subset.numer,
  };
}

/**
 * Read official population membership off an outcome's evidence, or `null` when this outcome was not
 * produced by the official executor (every authored measure today).
 */
export function officialMembership(evidence: unknown): PopulationMembership | null {
  const official = (evidence as { official?: { populationResults?: unknown } } | null | undefined)?.official;
  if (official === undefined || official === null) return null; // authored outcome — silent, expected.
  const results = official.populationResults;
  if (!results || typeof results !== "object") {
    alertUnreadableOfficialEvidence("populationResults is not an object or array", results);
    return null;
  }

  const raw: RawPopulationFlags = { ipp: false, denom: false, denex: false, numer: false, denexcep: false, numex: false };
  if (Array.isArray(results)) {
    let recognized = 0;
    for (const entry of results) {
      const key = POPULATION_CODE_TO_KEY[String((entry as { populationType?: unknown })?.populationType)];
      if (!key) continue;
      // NUMEX is a numerator MODIFIER, not a membership population: a vector naming it and none of
      // the required populations is still an unreadable writer (recognized stays 0 → alert + null).
      if (key !== "numex") recognized += 1;
      raw[key] = bool((entry as { result?: unknown })?.result);
    }
    if (recognized === 0) {
      alertUnreadableOfficialEvidence("no recognized populationType in the results array", results);
      return null;
    }
    return normalizeMembership(raw);
  }

  const r = results as Record<string, unknown>;
  // Require the full keyed shape: a partially-spelled payload (e.g. `denominator` instead of `denom`)
  // must NOT be read as "everything else is false" — that silently reports DENOM 0 / NUMER 0.
  const keys: Array<keyof PopulationMembership> = ["ipp", "denom", "denex", "numer"];
  if (keys.some((k) => typeof r[k] !== "boolean")) {
    alertUnreadableOfficialEvidence("keyed populationResults is missing a required boolean", results);
    return null;
  }
  return normalizeMembership({
    ipp: bool(r["ipp"]),
    denom: bool(r["denom"]),
    denex: bool(r["denex"]),
    numer: bool(r["numer"]),
    denexcep: bool(r["denexcep"]),
    numex: bool(r["numex"]),
  });
}

/**
 * Membership for one outcome: official evidence first, else the authored status rule (ADR-031) —
 * unchanged for every measure that has no official evidence, which today is all of them.
 *
 * MIXED PROVENANCE (accepted, documented): within one official-routed run, a subject whose official
 * evaluation errored persists `{evaluationError}` evidence and no `official` block, so it is counted by
 * the authored status rule while its peers are counted by official membership. For a lower-is-better
 * measure those are opposite numerator semantics inside one denominator. This is the same per-subject
 * error-isolation trade-off the run pipeline already makes (a failed subject becomes MISSING_DATA rather
 * than failing the run); PR-8's shadow period is where a run with any errored subject must be surfaced,
 * since only there can it be compared against a clean official run.
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

/**
 * The identity of the official artifact an outcome was scored by, or `null` for an authored outcome.
 *
 * Read from the OUTCOME, never from the environment. A report describes the run it is built from, and a
 * run's provenance does not change because someone later flipped a flag or re-vendored an artifact — so
 * asking `WORKWELL_OFFICIAL_MEASURES` here would mislabel every historical export the day the config
 * moves. The adapter persists `{ecqmId, version, engine, artifactSha256}` beside `populationResults`
 * precisely so this is answerable from the record (ADR-031).
 */
export interface OfficialReportIdentity {
  ecqmId?: string;
  version?: string;
  artifactSha256?: string;
  /**
   * The period the artifact was ACTUALLY executed over (ADR-072). The run row records one period for
   * the whole run, and `runMeasurementPeriod` only switches to the calendar year when EVERY measure in
   * the run is official-routed — so on a mixed run the run row states the authored rolling window while
   * the official counts were computed over the calendar year. This is the exported reporting period of
   * a MeasureReport or QRDA document, so taking it from the run row on a mixed run declares a period the
   * numbers were not counted over.
   */
  measurementPeriod?: { start: string; end: string };
}

export function officialReportIdentity(evidence: unknown): OfficialReportIdentity | null {
  const official = (evidence as { official?: Record<string, unknown> } | null | undefined)?.official;
  if (!official || typeof official !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    ...(str(official.ecqmId) ? { ecqmId: str(official.ecqmId) } : {}),
    ...(str(official.version) ? { version: str(official.version) } : {}),
    ...(str(official.artifactSha256) ? { artifactSha256: str(official.artifactSha256) } : {}),
    ...(officialPeriod(official.measurementPeriod) ? { measurementPeriod: officialPeriod(official.measurementPeriod)! } : {}),
  };
}

/** The persisted `official.measurementPeriod`, when it is a usable {start,end} pair. */
function officialPeriod(value: unknown): { start: string; end: string } | null {
  const p = value as { start?: unknown; end?: unknown } | null | undefined;
  if (!p || typeof p.start !== "string" || typeof p.end !== "string") return null;
  return { start: p.start, end: p.end };
}

/**
 * The period a report DECLARES: the official artifact's own executed period when the outcome carries
 * one, else the run row. See OfficialReportIdentity.measurementPeriod for why these can differ.
 */
export function reportingPeriod(
  run: { measurementPeriodStart: string; measurementPeriodEnd: string },
  official: OfficialReportIdentity | null,
): { start: string; end: string } {
  return official?.measurementPeriod ?? { start: run.measurementPeriodStart, end: run.measurementPeriodEnd };
}

/**
 * THE TRIO (ADR-046, discharging the PR-7 obligation this file has carried since PR-3).
 *
 * The prohibition used to read: WorkWell's numerator is compliance-oriented (including inverted CMS122
 * logic), so the canonical MUST stay WorkWell's — switching to an official CMS canonical is forbidden
 * *unless the numerator orientation and improvementNotation change together*. Evidence-first membership
 * (PR-3) made an official-routed outcome's numerator the OFFICIAL one, which turned that prohibition
 * into an obligation: **canonical, improvementNotation and membership must switch together or the
 * report contradicts itself.**
 *
 * For cms122 the contradiction is not cosmetic. Its official numerator is *poor glycemic control* — being
 * in it is the failure — so a report that also declares `improvementNotation: increase` says
 * higher-is-better about a numerator counting harm. On the 150-employee directory the numerator moves
 * ~120 → ~27, and QRDA III carries no notation element at all, so the inverted count would ship with
 * nothing marking it. Review of #356 caught that PR-9c was the flip that had to discharge this and had
 * not; cms122 was held out of that flip for exactly this reason.
 *
 * All three now derive from the same place — the outcome's own official evidence — so they cannot
 * disagree by construction.
 */
const measureCanonical = (measureId: string, official: OfficialReportIdentity | null): string => {
  if (!official) return `urn:workwell:measure:${measureId}`;
  const artifact = loadOfficialArtifact(measureId);
  // Only claim CMS's canonical for the artifact that ACTUALLY produced this outcome. A re-vendor between
  // the run and the export changes the sha; labelling the old report with the new canonical would assert
  // a provenance that never existed. Falling back to a version-qualified urn is less pretty and true.
  if (artifact && (!official.artifactSha256 || artifact.manifest.sha256 === official.artifactSha256)) {
    return artifact.manifest.url;
  }
  return `urn:workwell:measure:${measureId}:official:${official.version ?? "unknown"}`;
};

const improvementNotation = (
  measureId: string,
  official: OfficialReportIdentity | null,
): "increase" | "decrease" => {
  if (official) {
    // Sourced from the human-reviewed semantics table, NOT from the artifact's own
    // `improvementNotation` — for cms122 the artifact says `increase`, which contradicts eCQI's own
    // description of the measure, and `official-measure-semantics.ts` records that decision with its
    // rationale. There is no safe default here: guessing one way reports every failure as compliant.
    const semantics = officialMeasureSemantics(measureId);
    if (semantics) return semantics.numeratorMeansCompliant ? "increase" : "decrease";
    // A routed measure with no recorded semantics cannot be scored honestly. The router refuses this at
    // construction, so reaching it means the refusal was bypassed — say so rather than guess.
    alertUnreadableOfficialEvidence(`no recorded numerator semantics for routed measure '${measureId}'`, null);
  }
  return MEASURE_BINDINGS[measureId]?.improvementNotation ?? "increase";
};

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
  // Derive the artifact identity from the outcomes themselves — the same source the counts come from,
  // so the label and the numbers cannot describe different measures. Any row that carries it is
  // decisive: a run evaluates one measure with one engine, and a run where some subjects errored still
  // names the artifact the rest were scored by (ADR-046).
  const official = outcomes.map((o) => officialReportIdentity(o.evidence)).find((i) => i !== null) ?? null;
  return buildSummaryMeasureReportFromCounts(run, measureId, countPopulations(outcomes, measureId), generatedAt, official);
}

/** Summary MeasureReport from pre-aggregated counts (the bounded Fable H4 path). */
export function buildSummaryMeasureReportFromCounts(
  run: RunRecord,
  measureId: string,
  c: PopulationCounts,
  generatedAt: string,
  /**
   * The official artifact these counts came from, when they did. Explicit rather than inferred because
   * counts carry no evidence: the aggregate/scale path reduces STATUS buckets, which are authored
   * semantics by construction (`populationCountsFromStatus` says so), so its caller passes nothing.
   */
  official: OfficialReportIdentity | null = null,
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
    measure: measureCanonical(measureId, official),
    period: reportingPeriod(run, official),
    improvementNotation: { coding: [{ system: IMPROVEMENT_SYSTEM, code: improvementNotation(measureId, official) }] },
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
  const official = officialReportIdentity(outcome.evidence);
  return {
    resourceType: "MeasureReport",
    ...reportMetadata(generatedAt),
    status: "complete",
    type: "individual",
    measure: measureCanonical(measureId, official),
    // subjectId is the employee external id (used as the Patient ref); fhir_patient_id linkage is deferred (spec §7).
    subject: { reference: `Patient/${outcome.subjectId}` },
    period: reportingPeriod(run, official),
    improvementNotation: { coding: [{ system: IMPROVEMENT_SYSTEM, code: improvementNotation(measureId, official) }] },
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
