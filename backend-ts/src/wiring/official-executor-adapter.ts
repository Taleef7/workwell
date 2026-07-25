/**
 * Evaluate a measure by running the OFFICIAL published artifact (roadmap §7.2/§7.3, PR-7a).
 *
 * This is Nicole's first correction made executable: for a measure CMS publishes, run the steward's own
 * CQL rather than an authored approximation of it. The adapter implements the same
 * `EvaluateMeasureBinding` the authored engine implements, so PR-7b's router can dispatch per measure
 * with no signature change anywhere downstream.
 *
 * **Nothing routes here yet.** This ships dark: the router lands in PR-7b, the shadow comparison in
 * PR-8, and the flip in PR-9.
 *
 * ## Three safety properties, in order of how badly they fail
 *
 * 1. **Terminology completeness is checked BEFORE evaluating, and refuses.** `buildValueSetCache` emits a
 *    canonical it cannot expand as *empty but present*, because fqm aborts a whole batch on a missing
 *    value set. Empty is the conservative direction for a diagnostic, and a catastrophe for production:
 *    a retrieve against an empty set matches nothing, so a measure whose OIDs were never imported
 *    reports every subject as out-of-population — indistinguishable, downstream, from a genuinely
 *    ineligible roster. This adapter expands first and throws if ANY referenced value set fails to
 *    expand — including when the expander *throws*, which `buildValueSetCache` swallows.
 *
 *    Measured today: `pnpm resolve-valuesets` imports the 21 CMS122 reference OIDs, while CMS122's
 *    artifact references **26** (5 missing) and CMS125's references **32** (14 missing). So BOTH
 *    measures are refused right now, not just CMS125. Four of CMS122's five gaps are
 *    SupplementalDataElements sets that `calculateSDEs: false` never retrieves, so the refusal is
 *    deliberately broader than strictly necessary — the safe direction, and the fix (import them) is
 *    cheap. `requiredOids(artifact)` exists so the import CLI can be pointed at an artifact.
 * 2. **A measure with no recorded semantics, a non-proportion scoring, or an id/artifact mismatch cannot
 *    run.** See `official-measure-semantics.ts` — there is no safe default for "does the numerator mean
 *    compliant", and a cohort measure has no numerator at all.
 * 3. **The measurement period matches the authored path** (`evaluationDate - periodMonths` …
 *    `evaluationDate`, both read from the same `MEASURES` registry), not the artifact's
 *    `effectivePeriod`. That keeps the PR-8 shadow diff isolating the LOGIC difference rather than
 *    confounding it with a period change. Whether production should instead use the calendar
 *    measurement period an eCQM is defined on is a real question, left to PR-9.
 *
 * ## What this does NOT yet do — PR-7b's obligations, stated so they cannot be forgotten
 *
 * - **It does not prepare the bundle.** `standards/literal-diff.ts` must call `stampQiCoreStructure`
 *   (QICore active/confirmed status, in-past onset, Encounter class) before this same artifact reads
 *   WorkWell's synthetic bundles, or "the whole population reads out-of-population". This adapter takes
 *   the bundle it is handed. Wiring that preparation — and a batch-level `hasRetrieveSignal` check,
 *   which is only meaningful across subjects — belongs with the router.
 * - **It re-expands terminology on every call.** Fine for a dark, per-subject binding; not fine for a
 *   150-subject run, which would be ~300 ELM parses of a 2.4MB bundle and thousands of store reads on
 *   the database whose idle polling already caused a four-day outage. PR-7b batches per measure. Any
 *   cache must be scoped per run, not per process — `engineForEnv` deliberately rebuilds its resolver
 *   per call so operator value-set edits stay visible, and a process-lifetime memo re-introduces that
 *   fixed bug.
 * - **`inInitialPopulation` is computed here and dropped at persistence.** `run-pipeline.ts` stores only
 *   `outcome` and `evidence`, and MISSING_DATA opens a case — so today every out-of-IPP subject would
 *   become a case. True of the authored path too, but official routing over a live population makes the
 *   volume matter.
 * - **The display vocabulary lies about official EXCLUDED and OVERDUE.** `roster-vocabulary.ts`
 *   hardcodes "Contraindication / exemption on file" for every EXCLUDED — but this adapter routes three
 *   distinct conditions there (DENEX, DENEXCEP, out-of-denominator), and only the first is an exemption.
 *   Worse, it renders OVERDUE as "no record on file", which for cms122 is the factual opposite: OVERDUE
 *   means a *recorded* HbA1c above 9%. Both strings are written for authored recency measures and need
 *   an official-aware branch before anything renders an official outcome to an operator.
 * - **Only group 1 is read.** `detailedResults[0]`, like every existing consumer. Both vendored measures
 *   have exactly one group; several of the roadmap's remaining six do not, and a multi-group artifact
 *   deserves a refusal alongside the scoring guard rather than silently reporting its first group.
 */
import {
  buildValueSetCache,
  calculateOfficialDetailed,
  normalizePeriodEnd,
  referencedValueSets,
  referencedValueSetUrls,
  oidFromValueSetUrl,
  type ExpandedCode,
  type FqmCalculate,
  type FqmStatementResult,
  type PopulationMembership,
} from "@workwell/official-executor";
import type {
  EvaluateMeasureBinding,
  EvaluateMeasureInput,
  ExpressionResult,
  MeasureOutcome,
  OutcomeStatus,
} from "../engine/evaluate-measure.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";
import { officialMeasureSemantics } from "./official-measure-semantics.ts";

/** Expand one VSAC OID to its codes — the app supplies this from the imported `value_sets` rows. */
export type ExpandValueSet = (oid: string) => Promise<ExpandedCode[]>;

export interface OfficialExecutorDeps {
  expand: ExpandValueSet;
  /** Injectable for tests; defaults to the real (lazily imported) fqm calculator. */
  calculate?: FqmCalculate;
  /** Injectable for tests; defaults to the vendored-artifact loader. */
  loadArtifact?: (catalogId: string) => OfficialArtifact | null;
}

/**
 * Map official population membership onto WorkWell's five-bucket workflow vocabulary.
 *
 * The enum deliberately does NOT grow (roadmap §7.3): regulatory truth is persisted losslessly in
 * `evidence_json.official.populationResults`, and this is only the operator-facing bucket.
 *
 * - **not in IPP** → `MISSING_DATA` with `inInitialPopulation: false`. The pair is what distinguishes
 *   "out of scope for this measure" from "eligible but we have no data", which is the L17 signal.
 * - **DENEX** → `EXCLUDED`.
 * - **DENEXCEP** → `EXCLUDED` too. An excepted patient needs no outreach, which is the only question
 *   this vocabulary answers; the distinction that matters for reporting survives in populationResults.
 *   This is what unblocks CMS68-class measures with zero enum change.
 * - **numerator** → `COMPLIANT` or `OVERDUE` depending on the measure's semantics.
 *
 * `DUE_SOON` is never emitted: official CQL has no forecast define, and inventing one would be authoring
 * logic on top of the steward's. Accepted and documented — the forecaster remains a descriptive overlay.
 */
export function outcomeFromPopulations(
  populations: PopulationMembership,
  numeratorMeansCompliant: boolean,
): { outcome: OutcomeStatus; inInitialPopulation: boolean } {
  const inIpp = populations["initial-population"] === true;
  if (!inIpp) return { outcome: "MISSING_DATA", inInitialPopulation: false };
  if (populations["denominator-exclusion"] === true || populations["denominator-exception"] === true) {
    return { outcome: "EXCLUDED", inInitialPopulation: true };
  }
  // In the initial population but NOT the denominator: the measure does not score this subject, so
  // there is nothing to chase. Reading only IPP would call them OVERDUE (or COMPLIANT for an inverse
  // measure) and open a case they should never have. Latent for cms122/cms125, where DENOM equals IPP,
  // and reachable for measures whose denominator is a strict subset.
  //
  // `!== true`, matching the IPP check above rather than `=== false`. The caller has already refused
  // any non-proportion measure, so a proportion measure with no `denominator` population is a contract
  // violation — and falling through to the numerator branch on a missing key would be exactly the
  // guess this file refuses to make everywhere else.
  if (populations["denominator"] !== true) return { outcome: "EXCLUDED", inInitialPopulation: true };
  const inNumerator = populations["numerator"] === true;
  const compliant = inNumerator === numeratorMeansCompliant;
  return { outcome: compliant ? "COMPLIANT" : "OVERDUE", inInitialPopulation: true };
}

/**
 * The statements worth persisting: the measure's OWN library, not its 8-9 includes.
 *
 * A full CMS122 evaluation returns 419 statement results; keeping all of them would put ~25 KB of
 * evidence on every outcome row, against ~1-3 KB for an authored measure, on a database whose compute
 * budget has already caused one outage. The root library is where the population logic and the
 * measure-specific defines live — the includes are FHIRHelpers, status/date helpers, and shared
 * hospice/palliative libraries whose per-statement values explain nothing an operator would read.
 */
export const OFFICIAL_DEFINE_PREFIX = "official:";

/**
 * `expressionResults` for an official outcome: the POPULATION results, not the statement results.
 *
 * This is the second thing on this branch to be settled by measurement rather than reasoning, and the
 * answer inverted the design. The intent was to persist fqm's per-statement results the way the authored
 * engine persists CQL defines. They cannot carry values, because we strip ELM annotations when vendoring
 * (PR-6a, an 86% size cut) and `localId` goes with them — fqm resolves a statement's `raw` value BY
 * `localId`, so `raw` is always `undefined`, and `final` collapses to `NA | UNHIT | FALSE`. Measured on
 * the committed CMS122 artifact over six MADiE cases: **0 of 96 root statements ever read `TRUE`**, and a
 * subject the measure places in the numerator persists `official:Numerator = "FALSE"` beside
 * `populationResults: [{numerator, result: true}]` — two contradictory statements in one regulatory
 * record, with the false one being what the Evidence Explorer, the auditor packet and the AI explain
 * prompt render.
 *
 * So statement results are not persisted at all. `expressionResults` is derived from the population
 * membership instead: it cannot contradict `official.populationResults` because it IS
 * `official.populationResults`, and it gives the existing evidence surfaces something true to show.
 * Names are prefixed `official:` — honest (these are populations, not authored defines) and it keeps
 * them clear of `deriveWhyFlagged`'s anchored `/^most recent .*date$/i` and `/^days since/i` matchers.
 *
 * If per-statement values are ever genuinely wanted, the cost is explicit: vendor that measure
 * unstripped (~10.5MB instead of ~2.4MB) and revisit. PR-8 must not read `expressionResults` on an
 * official outcome expecting statement-level detail.
 */
export function populationExpressionResults(
  populationResults: readonly { populationType: string; result: boolean }[],
): ExpressionResult[] {
  return populationResults.map((p) => ({
    define: `${OFFICIAL_DEFINE_PREFIX}${p.populationType}`,
    result: p.result,
  }));
}

/**
 * `YYYY-MM-DD` minus n months. Character-for-character the authored engine's helper
 * (`cql-execution-engine.ts`), overflow behaviour included: 2024-02-29 minus 12 months is 2023-03-01,
 * not 2023-02-28. A "better" clamping version was the first cut, and it silently made the two paths
 * evaluate different measurement periods on one day a year — which PR-8's shadow diff would then report
 * as a logic divergence. Matching a quirk beats improving on it when the whole point is comparability.
 */
function subtractMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * Expand every value set the artifact's ELM retrieves, refusing if any comes back empty.
 *
 * Exported so PR-7b can preflight at ROUTER CONSTRUCTION — an operator who flips a measure whose
 * terminology was never imported should learn about it at boot, not from a population run that quietly
 * reports nobody as eligible.
 */
export async function expandArtifactTerminology(
  artifact: OfficialArtifact,
  expand: ExpandValueSet,
): Promise<unknown[]> {
  const referenced = referencedValueSetUrls(artifact.bundle);
  const unusable = new Set<string>();
  const cache = await buildValueSetCache(artifact.bundle, async (oid) => {
    // `buildValueSetCache` catches whatever this callback throws and substitutes an empty expansion, so
    // recording emptiness only on the success path misses the most likely production trigger of all: a
    // transient store failure mid-run. Catching HERE is what makes the refusal airtight — verified by a
    // test that throws from the expander and asserts the refusal still fires.
    let codes: ExpandedCode[];
    try {
      codes = await expand(oid);
    } catch {
      unusable.add(oid);
      return [];
    }
    // Returning a non-array would fail closed anyway — but as a raw TypeError from inside
    // `buildValueSetCache`'s `.map`, losing the diagnostic that names the OIDs and the CLI that fixes
    // them, which is the entire value of this refusal. Normalize to `[]` so the real message wins.
    if (!Array.isArray(codes) || codes.length === 0) {
      unusable.add(oid);
      return [];
    }
    return codes;
  });
  if (unusable.size > 0) {
    const oids = [...unusable];
    // Both sides are counted as distinct OIDs. `referenced` holds canonical URLs, and two canonicals
    // can collapse to one OID — comparing the sets directly would under-report the failure ("1 of 3"
    // for two failing canonicals).
    const referencedOids = new Set(referenced.map(oidFromValueSetUrl)).size;
    throw new Error(
      `${artifact.manifest.catalogId}: ${unusable.size} of ${referencedOids} value sets could not be ` +
        `expanded (${oids.slice(0, 5).join(", ")}${oids.length > 5 ? ", …" : ""}). Official execution ` +
        `would report every subject out-of-population. Import them with 'pnpm resolve-valuesets' ` +
        `before routing ${artifact.manifest.catalogId} officially.`,
    );
  }
  return cache;
}

/** The bare OIDs an artifact needs expanded — for preflight reporting and the import CLI. */
export function requiredOids(artifact: OfficialArtifact): string[] {
  return referencedValueSetUrls(artifact.bundle).map(oidFromValueSetUrl);
}

/**
 * The value sets an artifact needs, with the CQL alias each is declared under.
 *
 * This is what `pnpm resolve-valuesets --official <catalogId>` imports. Deriving the target list from
 * the artifact — rather than a hand-kept OID table — is what keeps the importer and the executor's
 * refusal in agreement: the same ELM that decides "this measure cannot run without these" decides what
 * gets fetched. A hand-kept list is exactly how CMS122 ended up importable while 5 of its 26 canonicals
 * were missing.
 */
export function requiredValueSets(artifact: OfficialArtifact): Array<{ oid: string; name?: string }> {
  return referencedValueSets(artifact.bundle).map((v) => ({
    oid: oidFromValueSetUrl(v.url),
    ...(v.name ? { name: v.name } : {}),
  }));
}

/**
 * An `EvaluateMeasureBinding` that runs the official artifact for whichever measure it is asked about.
 *
 * Single-subject by design at this stage: it is the binding contract every caller already uses. That
 * costs an ELM parse per subject, which is why PR-7b adds measure-major iteration and batches subjects
 * through one `calculateOfficialDetailed` call — the package's batch entry point already exists for it.
 */
export function officialMeasureExecutor(deps: OfficialExecutorDeps): EvaluateMeasureBinding {
  return {
    async evaluate(input: EvaluateMeasureInput): Promise<MeasureOutcome> {
      const artifact = (deps.loadArtifact ?? loadOfficialArtifact)(input.measureId);
      if (!artifact) {
        throw new Error(`${input.measureId}: no executable official artifact is vendored`);
      }
      // The artifact and the semantics are looked up by the same key but from different places; a
      // mismatch would run one measure under another's reading of its numerator.
      if (artifact.manifest.catalogId !== input.measureId) {
        throw new Error(
          `${input.measureId}: loaded artifact declares catalogId '${artifact.manifest.catalogId}'`,
        );
      }
      // Scoring is in the refusal list for the same reason the other two are: a `cohort` or
      // `continuous-variable` artifact has no numerator population at all, so `populations["numerator"]`
      // is undefined, and the mapping below would silently call every subject COMPLIANT or every
      // subject OVERDUE depending on one flag.
      if (artifact.manifest.scoring !== "proportion") {
        throw new Error(
          `${input.measureId}: scoring '${artifact.manifest.scoring}' is not supported — the ` +
            `population mapping assumes a proportion measure`,
        );
      }
      const semantics = officialMeasureSemantics(input.measureId);
      if (!semantics) {
        throw new Error(
          `${input.measureId}: no recorded official measure semantics — refusing to guess whether its ` +
            `numerator means compliant (see official-measure-semantics.ts)`,
        );
      }

      const evaluationDate = input.evaluationDate ?? new Date().toISOString().slice(0, 10);
      // Read from the SAME registry the authored path reads, rather than hardcoding 12: PR-8 compares
      // the two engines' outcomes, and a period they disagree on would surface as a logic divergence.
      const periodMonths = MEASURES[input.measureId]?.periodMonths ?? 12;
      const period = {
        start: subtractMonths(evaluationDate, periodMonths),
        end: normalizePeriodEnd(evaluationDate),
      };

      const valueSetCache = await expandArtifactTerminology(artifact, deps.expand);
      const results = await calculateOfficialDetailed({
        bundle: artifact.bundle,
        patientBundles: [input.patientBundle],
        period,
        valueSetCache,
        ...(deps.calculate ? { calculate: deps.calculate } : {}),
        // `trustMetaProfile` stays FALSE. The first cut set it true, reasoning that official artifacts
        // retrieve by QICore profile — which is true of the artifact and false as a configuration for
        // OUR bundles. With it on, cql-exec-fhir filters every retrieve to resources whose `meta.profile`
        // contains the exact templateId canonical: the ELM asks for `qicore-condition-problems-health-
        // concerns` and `qicore-observation-lab`, while `fhir-bundle-builder.ts` stamps `qicore-condition`
        // and `qicore-observation-clinical-result`. Nothing matches, every subject silently leaves the
        // denominator — the same empty-population catastrophe the terminology preflight above refuses,
        // through a different door. For a WebChart-derived bundle (no `meta.profile` at all) it is worse:
        // the Patient retrieve THROWS. `standards/literal-diff.ts` runs this same artifact over these
        // same bundles with the default (false) — that is the precedent, and the honest statement of
        // it. NOT "the 121/121 gate proves false works": the MADiE harness starts at false and RETRIES
        // at true when no retrieve matches, so the green gate run lands on true for the profile-tagged
        // test-case bundles. It says nothing about our own data shape either way.
      });

      const [subjectId, result] = [...results][0] ?? [];
      if (!subjectId || !result) {
        throw new Error(`${input.measureId}: the official artifact returned no result for this subject`);
      }

      const { outcome, inInitialPopulation } = outcomeFromPopulations(
        result.populations,
        semantics.numeratorMeansCompliant,
      );
      return {
        subjectId,
        // The catalog's display name, matching the authored path — not the artifact's machine name
        // (`CMS122FHIRDiabetesAssessGT9Pct`), which the headless CLI would then print at a human.
        measure: MEASURES[input.measureId]?.name ?? artifact.manifest.measureName,
        outcome,
        inInitialPopulation,
        evidence: {
          expressionResults: populationExpressionResults(result.populationResults),
          // The regulatory truth, verbatim and lossless. MeasureReport/QRDA read THIS (ADR-031/PR-3),
          // never the workflow bucket above — the bucket cannot express DENEXCEP and inverts for an
          // inverse measure.
          official: {
            ecqmId: artifact.manifest.cmsId,
            version: artifact.manifest.version,
            engine: "fqm-execution",
            artifactSha256: artifact.manifest.sha256,
            populationResults: result.populationResults,
          },
        },
      };
    },
  };
}
