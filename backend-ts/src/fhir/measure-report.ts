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

/**
 * One stratifier of one group, in the shape the steward's own MADiE MeasureReports use: keyed by the
 * artifact's `Measure.group.stratifier.id` (`Stratification_1_1`), with a `true` and a `false` stratum
 * each carrying the population counts of the subjects in and out of it.
 */
export interface Stratifier {
  id: string;
  stratum: Array<{ value: { text: "true" | "false" }; population: Population[]; measureScore?: { value: number } }>;
}

/** Per stratifier of one rate: the counts of the subjects IN the stratum and OUT of it. */
export interface StratumCounts {
  id: string;
  inStratum: PopulationCounts;
  notInStratum: PopulationCounts;
}

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
  /** `id` is present only on a MULTI-RATE report, mirroring the artifact's own Group_1/Group_2. */
  group: Array<{ id?: string; population: Population[]; measureScore?: { value: number }; stratifier?: Stratifier[] }>;
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
/**
 * Membership PER RATE. A multi-rate measure persists every rate in `evidence.official.rates`; anything
 * else has exactly one, so this returns a single-element array and behaves as before.
 */
export function membershipRatesFor(
  outcome: Pick<OutcomeRecord, "status" | "evidence">,
  measureId: string,
): PopulationMembership[] {
  const rates = (outcome.evidence as { official?: { rates?: unknown } } | null | undefined)?.official?.rates;
  if (!Array.isArray(rates) || rates.length <= 1) return [membershipFor(outcome, measureId)];
  return rates.map((populationResults) => {
    const membership = officialMembership({ official: { populationResults } });
    if (membership) return membership;
    // An unreadable rate contributes NOTHING rather than rate 1's answer. Falling back to
    // `membershipFor` here restated Initiation's numbers under Engagement's heading — a plausible
    // duplicate is worse than a visible zero, because only one of the two is obviously wrong to a
    // reader. `officialMembership` has already alerted on the unreadable evidence.
    return { ipp: false, denom: false, denex: false, numer: false, denexcep: false };
  });
}

/**
 * Proportion counts PER RATE, aggregated across subjects — one entry per group the measure declares.
 *
 * CMS137 has two (Initiation and Engagement) and they genuinely differ: a patient can start treatment
 * and not continue it. A MeasureReport that emitted one group would report half the measure, and the
 * half it dropped is the one the ACO is asking about (ADR-074).
 */
export function countPopulationsByRate(outcomes: OutcomeRecord[], measureId: string): PopulationCounts[] {
  return aggregateByRate(outcomes, measureId).rates;
}

const addMembership = (counts: PopulationCounts, m: PopulationMembership): void => {
  if (!m.ipp) return;
  counts.ipp += 1;
  if (m.denom) counts.denom += 1;
  if (m.denex) counts.denex += 1;
  if (m.numer) counts.numer += 1;
  if (m.denexcep) counts.denexcep += 1;
};

/**
 * Per-subject stratum membership, per rate, off `evidence.official.strata` — `null` when the measure
 * declares no stratifier (every measure but cms137 today) or the outcome predates their persistence.
 */
export function strataRatesFor(outcome: Pick<OutcomeRecord, "evidence">): Array<Array<{ id: string; result: boolean }>> | null {
  const strata = (outcome.evidence as { official?: { strata?: unknown } } | null | undefined)?.official?.strata;
  if (!Array.isArray(strata)) return null;
  return strata.map((rate) =>
    Array.isArray(rate)
      ? rate
          .filter((s): s is { id: string; result: boolean } => typeof (s as { id?: unknown })?.id === "string")
          .map((s) => ({ id: s.id, result: s.result === true }))
      : [],
  );
}

/**
 * Populations AND strata per rate, aggregated across subjects — one entry per group the measure
 * declares, and for each group one entry per stratifier it declares.
 *
 * CMS137 has two groups (Initiation and Engagement) and they genuinely differ: a patient can start
 * treatment and not continue it. A MeasureReport that emitted one group would report half the measure,
 * and the half it dropped is the one the ACO is asking about (ADR-074). Each group also declares three
 * age strata, and a QRDA III for a stratified measure has to report every one of them — so they are
 * counted here, from the same memberships, rather than left to a second pass that could disagree.
 *
 * The RATE COUNT this run is reporting on is the widest any subject carries. A subject whose official
 * evaluation errored has no `official.rates` and yields one membership, and adding it at index 0 only
 * would inflate rate 1's denominator relative to rate 2 — for two rates whose denominator is the same
 * CQL expression. That is a cross-rate arithmetic inconsistency no reader could detect, so a subject
 * that cannot supply every rate is counted in NONE of them, surfaces as the gap between the denominators
 * and the roster, and is reported in `unmeasured` so the gap has a number (ADR-074 d5).
 */
export function aggregateByRate(
  outcomes: OutcomeRecord[],
  measureId: string,
): RateAggregate {
  const aggregator = createRateAggregator(measureId);
  for (const outcome of outcomes) aggregator.add(outcome);
  return aggregator.finish();
}

export interface RateAggregate {
  rates: PopulationCounts[];
  strata: StratumCounts[][];
  /** Subjects counted in NO rate because they could not supply every rate (ADR-074 d5). */
  unmeasured: number;
}

/**
 * The same aggregation, fed one outcome at a time — so a 20,000-subject run can be summed from PAGED
 * reads instead of one `listOutcomes(runId)` that materialises 120,000 evidence blobs. Only the
 * per-subject memberships and stratum flags are retained until `finish()`, because the "counted in no
 * rate" rule needs the widest rate count any subject carries, which is not known until the last row.
 */
export function createRateAggregator(measureId: string): { add(outcome: Pick<OutcomeRecord, "status" | "evidence">): void; finish(): RateAggregate } {
  const retained: Array<{ memberships: PopulationMembership[]; strata: Array<Array<{ id: string; result: boolean }>> | null }> = [];
  let declaredRates = 0;
  return {
    add(outcome) {
      const memberships = membershipRatesFor(outcome, measureId);
      declaredRates = Math.max(declaredRates, memberships.length);
      retained.push({ memberships, strata: strataRatesFor(outcome) });
    },
    finish() {
      const perRate: PopulationCounts[] = [];
      const perRateStrata: Array<Map<string, StratumCounts>> = [];
      let unmeasured = 0;
      for (const { memberships, strata } of retained) {
        if (declaredRates > 1 && memberships.length !== declaredRates) {
          unmeasured += 1;
          continue;
        }
        for (const [index, m] of memberships.entries()) {
          addMembership((perRate[index] ??= zeroCounts()), m);
          for (const stratum of strata?.[index] ?? []) {
            const byId = (perRateStrata[index] ??= new Map());
            const counts = byId.get(stratum.id) ?? { id: stratum.id, inStratum: zeroCounts(), notInStratum: zeroCounts() };
            byId.set(stratum.id, counts);
            addMembership(stratum.result ? counts.inStratum : counts.notInStratum, m);
          }
        }
      }
      const rates = perRate.length > 0 ? perRate : [zeroCounts()];
      return {
        rates,
        strata: rates.map((_, index) => [...(perRateStrata[index]?.values() ?? [])]),
        unmeasured,
      };
    },
  };
}

/** The FHIR `stratifier` element for one group, in the steward's own true/false-stratum shape. */
export function stratifierElements(strata: StratumCounts[]): Stratifier[] {
  const stratum = (text: "true" | "false", counts: PopulationCounts) => {
    const effective = counts.denom - counts.denex - counts.denexcep;
    return {
      value: { text },
      population: populations(counts),
      ...(effective > 0 ? { measureScore: { value: counts.numer / effective } } : {}),
    };
  };
  return strata.map((s) => ({ id: s.id, stratum: [stratum("true", s.inStratum), stratum("false", s.notInStratum)] }));
}

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
  const { rates, strata } = aggregateByRate(outcomes, measureId);
  return buildSummaryMeasureReportFromCounts(run, measureId, rates.length > 1 ? rates : rates[0]!, generatedAt, official, strata);
}

/** Summary MeasureReport from pre-aggregated counts (the bounded Fable H4 path). */
export function buildSummaryMeasureReportFromCounts(
  run: RunRecord,
  measureId: string,
  /**
   * One rate's counts, or an ARRAY with one entry per rate for a multi-rate measure. CMS137 declares
   * two (Initiation and Engagement) and each becomes its own `group`, which is what the FHIR shape is
   * for — collapsing them would report half the measure (ADR-074).
   */
  c: PopulationCounts | PopulationCounts[],
  generatedAt: string,
  /**
   * The official artifact these counts came from, when they did. Explicit rather than inferred because
   * counts carry no evidence: the aggregate/scale path reduces STATUS buckets, which are authored
   * semantics by construction (`populationCountsFromStatus` says so), so its caller passes nothing.
   */
  official: OfficialReportIdentity | null = null,
  /** Per rate, the strata the group declares (empty for an unstratified group). Index-aligned with `c`. */
  strata: StratumCounts[][] = [],
): MeasureReport {
  const rates = Array.isArray(c) ? c : [c];
  const groups = rates.map((counts, index) => {
    // A multi-rate report gets group IDS, matching the steward's own `Group_1`/`Group_2` convention
    // (the artifact's Measure.group carries the same). Without them a consumer can only tell Initiation
    // from Engagement by array order, and nothing in the document asserts that order. Single-rate
    // reports keep no id, so the eight existing measures are byte-identical.
    const group: MeasureReport["group"][number] = rates.length > 1
      ? { id: `Group_${index + 1}`, population: populations(counts) }
      : { population: populations(counts) };
    // eCQM proportion score: exceptions are removed from the denominator alongside exclusions.
    // `denexcep` is 0 for every authored measure, so this is arithmetically unchanged for them.
    const effectiveDenominator = counts.denom - counts.denex - counts.denexcep;
    if (effectiveDenominator > 0) group.measureScore = { value: counts.numer / effectiveDenominator };
    // Strata, in the steward's own true/false-stratum shape, only where the group declares them — every
    // unstratified report is byte-identical.
    const groupStrata = strata[index] ?? [];
    if (groupStrata.length > 0) group.stratifier = stratifierElements(groupStrata);
    return group;
  });
  return {
    resourceType: "MeasureReport",
    ...reportMetadata(generatedAt),
    status: "complete",
    type: "summary",
    measure: measureCanonical(measureId, official),
    period: reportingPeriod(run, official),
    improvementNotation: { coding: [{ system: IMPROVEMENT_SYSTEM, code: improvementNotation(measureId, official) }] },
    group: groups,
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
  // Per RATE, like the summary. A single-rate measure yields one group and is unchanged; for cms137 an
  // individual report with one group made the BUNDLE self-contradictory — a two-group summary over 45
  // one-group individuals (ADR-074).
  const memberships = membershipRatesFor(outcome, measureId);
  const perRate = memberships.map(asCounts);
  const strata = strataRatesFor(outcome);
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
    group: perRate.map((counts, index) => {
      const group: MeasureReport["group"][number] = perRate.length > 1
        ? { id: `Group_${index + 1}`, population: populations(counts) }
        : { population: populations(counts) };
      // The subject's OWN stratum membership, as the steward's individual reports carry it: the counts
      // land in the `true` stratum when the subject is in it and in the `false` one when not.
      const own = strata?.[index] ?? [];
      if (own.length > 0) {
        group.stratifier = stratifierElements(
          own.map((s) => ({ id: s.id, inStratum: s.result ? counts : zeroCounts(), notInStratum: s.result ? zeroCounts() : counts })),
        );
      }
      return group;
    }),
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
