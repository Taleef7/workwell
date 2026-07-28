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
 * - **DONE in PR-8: it prepares the bundle.** `preparedForQiCore` runs on a structural COPY before
 *   every evaluation (QI-Core active/confirmed status, in-past onset, Encounter class). Measured
 *   without it, an unprepared synthetic roster scores IPP=0 — a run that completes and reports
 *   everyone MISSING_DATA.
 * - **DONE in PR-8: measure-major batching + the batch-level retrieve check.** `evaluateBatch` is now
 *   the primitive and `evaluate` is a batch of one. Measured on the real vendored artifacts: 171 ms per
 *   subject one at a time versus 11-16 ms batched (10x at 25 subjects, 16x at 100 — the ELM parse is
 *   per CALL, so the saving grows with the roster). Worth stating plainly, because it inverts the
 *   comparison the roadmap worried about: unbatched official execution is ~2.5x SLOWER per subject than
 *   the authored engine's ~68 ms, and batched it is faster.
 *
 *   The retrieve check rides with it, because it is only meaningful ACROSS subjects. Note it would NOT
 *   catch the more dangerous case — see `qicore-preparation.ts` on why preparation alone renders the
 *   synthetic corpus as 100% compliant for cms122. It catches "retrieved nothing at all", not
 *   "retrieved the wrong thing".
 * - **Terminology is expanded once per measure per EXECUTOR INSTANCE, not per call** (see `cacheFor`).
 *   Any cache must stay scoped per run, not per process — `engineForEnv` deliberately rebuilds its
 *   resolver per call so operator value-set edits stay visible, and a process-lifetime memo
 *   re-introduces that fixed bug.
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
  calculateOfficialWithSignal,
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
import { preparedForQiCore, type PreparableBundle } from "./qicore-preparation.ts";

/**
 * Expand one value-set OID to its codes, for a named measure.
 *
 * The `catalogId` is not decoration: terminology belongs to the ARTIFACT, and two artifacts pinned at
 * different upstream commits may legitimately disagree about the same OID. An expander keyed only by OID
 * has to pick one of them, silently, for both measures (roadmap §4.3 — one terminology authority, and it
 * is the artifact's own).
 */
export type ExpandValueSet = (oid: string, catalogId: string) => Promise<ExpandedCode[]>;

/**
 * Re-exported so the ROUTER can key its expander by the same rule `buildValueSetCache` looks up by,
 * without becoming a direct consumer of the executor package. Two normalizations that merely agree on
 * VSAC canonicals is a bug waiting for the first canonical of another shape; a second import of the
 * package into production wiring is a hole in the fqm quarantine. This is how to have neither.
 */
export { oidFromValueSetUrl, type FqmCalculate, type ExpandedCode };

/** One subject's input to a batched official evaluation. */
export interface OfficialBatchSubject {
  /**
   * The id the CALLER knows this person by, which the results are keyed back to. Deliberately not
   * assumed equal to the bundle's `Patient.id`: the synthetic directory makes them equal, every live
   * WebChart subject makes them differ (`wc|123` vs `123`), and a correlation that works only for the
   * former fails silently for exactly the population official routing exists to serve.
   */
  subjectId: string;
  patientBundle: unknown;
}

/** The `Patient.id` fqm will key this bundle's results by — the id we must correlate back FROM. */
function patientIdOf(bundle: unknown): string | undefined {
  const entries = (bundle as PreparableBundle | undefined)?.entry;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const resource = entry?.resource;
    if (resource?.["resourceType"] === "Patient" && typeof resource["id"] === "string") return resource["id"];
  }
  return undefined;
}

/** An `EvaluateMeasureBinding` that can also be asked to prove a measure is runnable before a run. */
export interface OfficialMeasureExecutor extends EvaluateMeasureBinding {
  preflight(measureId: string): Promise<void>;
  /**
   * Evaluate a whole roster for ONE measure in a single fqm pass, keyed by subject id.
   *
   * This is the primitive; `evaluate` is a one-subject call into it. fqm parses the artifact's ELM per
   * CALL, not per subject, so a 150-subject measure paid 150 parses of a 2.4 MB bundle to learn what one
   * pass answers.
   *
   * A subject fqm returns no detailed result for is ABSENT from the returned map rather than defaulted
   * to something. Only the caller knows who it asked for, so only the caller can judge the omission. The
   * run pipeline re-evaluates such a subject on its own — one extra call, and if fqm genuinely has
   * nothing for them the single-subject path raises it as that subject's isolated failure. Note the
   * consequence: a lone re-evaluation is a batch of one and so is exempt from the `> 1` retrieve check
   * below, which is correct for a real omission and is also why the map's KEYING has to be right (a
   * mis-keyed result looks exactly like a universal omission, and degrades silently to per-subject).
   */
  evaluateBatch(
    measureId: string,
    subjects: readonly OfficialBatchSubject[],
    evaluationDate?: string,
  ): Promise<Map<string, MeasureOutcome>>;
}

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
 * The measurement period an official artifact is executed over — **one definition, shared with the
 * shadow diff**, for the same reason `qicore-preparation.ts` is shared: a diff that runs a different
 * measurement period than the runtime does not forecast the flip, it forecasts a configuration that
 * will never exist.
 *
 * They genuinely differed until PR-8d. `standards/literal-diff.ts` used the CALENDAR YEAR
 * (`2026-01-01 … 2026-12-31`) while this adapter used the registry's rolling window
 * (`evaluationDate − periodMonths … evaluationDate`) — so for an as-of of 2026-07-27 the two engines
 * were being compared over periods sharing barely half their days, and every resulting difference would
 * have been read as a LOGIC divergence.
 *
 * The window itself is deliberately the registry's, matching the authored path, so the shadow isolates
 * logic rather than confounding it with a period change. Whether production should instead use the
 * calendar measurement period an eCQM is defined on is a real question, still open for PR-9 — and now
 * it is one edit rather than two that could drift apart.
 */
export function officialMeasurementPeriod(
  measureId: string,
  evaluationDate: string,
): { start: string; end: string } {
  const periodMonths = MEASURES[measureId]?.periodMonths ?? 12;
  return { start: subtractMonths(evaluationDate, periodMonths), end: normalizePeriodEnd(evaluationDate) };
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
      codes = await expand(oid, artifact.manifest.catalogId);
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
        `would report every subject out-of-population. Regenerate this measure's terminology with ` +
        `'pnpm vendor:official' before routing ${artifact.manifest.catalogId} officially — official ` +
        `execution uses the artifact's own expansions, NOT the 'pnpm resolve-valuesets' VSAC import.`,
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
export function officialMeasureExecutor(deps: OfficialExecutorDeps): OfficialMeasureExecutor {
  /**
   * Terminology is expanded once per measure per EXECUTOR INSTANCE — and an instance lives as long as
   * the router that built it, which is **at most** one run: per run-POST and per scheduled tick, but
   * per HTTP request at the read routes (`/simulate`, impact-preview, `/evaluate`). Shorter is always
   * SAFE — freshness is the property that matters — but it is not free: each construction pays a
   * `valueSets.listAll()` and an ELM walk per routed measure, and `/simulate` is a date scrubber that
   * fires once per drag. Worth revisiting when a read route is actually routed officially.
   *
   * The scoping is the point, not an implementation detail. A process-lifetime cache would freeze the
   * value-set snapshot and re-introduce the bug `engineForEnv` documents at length — an operator's
   * value-set edit serving stale expansions until restart. Per-CALL was the other extreme: a
   * 150-subject run re-parsing a 2.4MB bundle's ELM twice per subject and hitting the store thousands
   * of times.
   */
  const terminology = new Map<string, Promise<unknown[]>>();
  const cacheFor = (artifact: OfficialArtifact): Promise<unknown[]> => {
    const key = artifact.manifest.catalogId;
    let pending = terminology.get(key);
    if (!pending) {
      pending = expandArtifactTerminology(artifact, deps.expand);
      // A rejected promise must not be cached: the likeliest cause is a transient store failure, and
      // caching it would turn one bad read into a whole run's worth of refusals.
      pending.catch(() => terminology.delete(key));
      terminology.set(key, pending);
    }
    return pending;
  };

  const runBatch = async (
    measureId: string,
    subjects: readonly OfficialBatchSubject[],
    evaluationDate?: string,
  ): Promise<Map<string, MeasureOutcome>> => {
    const artifact = (deps.loadArtifact ?? loadOfficialArtifact)(measureId);
    if (!artifact) {
      throw new Error(`${measureId}: no executable official artifact is vendored`);
    }
    // The artifact and the semantics are looked up by the same key but from different places; a
    // mismatch would run one measure under another's reading of its numerator.
    if (artifact.manifest.catalogId !== measureId) {
      throw new Error(`${measureId}: loaded artifact declares catalogId '${artifact.manifest.catalogId}'`);
    }
    // Scoring is in the refusal list for the same reason the other two are: a `cohort` or
    // `continuous-variable` artifact has no numerator population at all, so `populations["numerator"]`
    // is undefined, and the mapping below would silently call every subject COMPLIANT or every
    // subject OVERDUE depending on one flag.
    if (artifact.manifest.scoring !== "proportion") {
      throw new Error(
        `${measureId}: scoring '${artifact.manifest.scoring}' is not supported — the ` +
          `population mapping assumes a proportion measure`,
      );
    }
    const semantics = officialMeasureSemantics(measureId);
    if (!semantics) {
      throw new Error(
        `${measureId}: no recorded official measure semantics — refusing to guess whether its ` +
          `numerator means compliant (see official-measure-semantics.ts)`,
      );
    }
    // Refusals first, then this: an empty batch is not an error, but it must not reach fqm — asking a
    // calculator about nobody is how you get an unhelpful failure deep inside someone else's library.
    if (subjects.length === 0) return new Map();

    const asOf = evaluationDate ?? new Date().toISOString().slice(0, 10);
    // Read from the SAME registry the authored path reads, rather than hardcoding 12, and through the
    // SAME helper the shadow diff calls — see `officialMeasurementPeriod`.
    const period = officialMeasurementPeriod(measureId, asOf);

    const valueSetCache = await cacheFor(artifact);
    // Prepared, and on a COPY. Official artifacts retrieve against QI-Core profiles, which are
    // stricter than the plain FHIR this repo emits — measured, an unprepared synthetic roster scores
    // IPP=0 across the board (`qicore-preparation.ts`). The copy is what keeps ADR-008: the authored
    // engine may evaluate these same bundle objects, and its outcomes must be byte-identical whether
    // or not official routing is on.
    const patientBundles = subjects.map((s) => preparedForQiCore(s.patientBundle as PreparableBundle));

    // fqm keys its results by the bundle's `Patient.id`, which is NOT the caller's subject id. For the
    // synthetic directory the two coincide (`fhir-bundle-builder` stamps `Patient.id = externalId`); for
    // a live WebChart subject they never do, because the directory prefixes the tenant (`wc|123` for
    // `Patient.id` `123`). Returning fqm's key would therefore look correct on every synthetic test and
    // silently match nothing for the exact population official routing is aimed at — review caught this
    // with the caller's own map lookup. So correlate here, where both ids are in scope, and return the
    // id the CALLER asked about.
    const subjectIdByPatientId = new Map<string, string>();
    for (const [i, s] of subjects.entries()) {
      const patientId = patientIdOf(patientBundles[i]);
      if (patientId === undefined) continue; // no Patient ⇒ fqm returns nothing for it ⇒ absent, per the contract
      // Two subjects sharing a Patient.id would make fqm's own results ambiguous, and picking one would
      // attribute a person's compliance to somebody else. Refuse instead — there is no safe guess.
      const clash = subjectIdByPatientId.get(patientId);
      if (clash !== undefined && clash !== s.subjectId) {
        throw new Error(
          `${measureId}: subjects '${clash}' and '${s.subjectId}' share Patient.id '${patientId}' — ` +
            `refusing to attribute one subject's result to another`,
        );
      }
      subjectIdByPatientId.set(patientId, s.subjectId);
    }
    const { bySubject, retrieveSignal } = await calculateOfficialWithSignal({
      bundle: artifact.bundle,
      patientBundles,
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

    // The batch-level safety net (roadmap §7.4). fqm does not error when every retrieve comes back
    // empty: it returns a complete-looking result with nobody in any population, which reads downstream
    // exactly like a legitimately ineligible roster. That is what a profile or terminology
    // misconfiguration looks like, and it is the one failure this executor could otherwise report as a
    // successful run in which every single person happens to be out of scope.
    //
    // Checked ACROSS subjects and only for MORE THAN ONE, because for a single subject "nothing
    // retrieved" is a true and ordinary answer — that is `/simulate` or rerun-to-verify on someone with
    // no clinical data, and failing it would be a false alarm on a correct result. Across a roster it
    // is not ordinary: someone in it has an Encounter. The known false positive is a roster of 2+ where
    // genuinely nobody has any clinical resource at all; failing loudly there is still the better
    // error, because the measure's output over that roster would be meaningless either way.
    if (subjects.length > 1 && !retrieveSignal) {
      throw new Error(
        `${measureId}: the official artifact retrieved NOTHING for any of ${subjects.length} subjects — ` +
          `refusing to report an entire roster out-of-population. That is what a profile or terminology ` +
          `misconfiguration looks like, not a result.`,
      );
    }

    const outcomes = new Map<string, MeasureOutcome>();
    for (const [patientId, result] of bySubject) {
      // Back to the caller's id. A result fqm returns for a patient nobody asked about cannot be
      // attributed and is dropped rather than guessed at.
      const subjectId = subjectIdByPatientId.get(patientId);
      if (subjectId === undefined) continue;
      const { outcome, inInitialPopulation } = outcomeFromPopulations(
        result.populations,
        semantics.numeratorMeansCompliant,
      );
      outcomes.set(subjectId, {
        subjectId,
        // The catalog's display name, matching the authored path — not the artifact's machine name
        // (`CMS122FHIRDiabetesAssessGT9Pct`), which the headless CLI would then print at a human.
        measure: MEASURES[measureId]?.name ?? artifact.manifest.measureName,
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
      });
    }
    return outcomes;
  };

  return {
    /**
     * Expand a measure's terminology now rather than at first evaluation. The router calls this at
     * construction so an operator who flips a measure whose OIDs were never imported learns it from a
     * failed run start, not from a run that quietly reports nobody as eligible.
     */
    async preflight(measureId: string): Promise<void> {
      const artifact = (deps.loadArtifact ?? loadOfficialArtifact)(measureId);
      if (!artifact) throw new Error(`${measureId}: no executable official artifact is vendored`);
      await cacheFor(artifact);
    },

    /**
     * One subject, expressed as a batch of one — so there is a single code path rather than two that
     * have to be kept in agreement (the same reason the package derives `calculateOfficial` from
     * `calculateOfficialDetailed`). This is the path `/simulate`, rerun-to-verify and the headless CLI
     * take, and the one that must NOT apply the batch retrieve check: for a single subject, "nothing
     * was retrieved" is a legitimate answer about that person.
     */
    async evaluate(input: EvaluateMeasureInput): Promise<MeasureOutcome> {
      // The subject id a single evaluation reports has always been the bundle's own `Patient.id` (it
      // came straight back from fqm), and the headless CLI prints it — so name it explicitly here rather
      // than letting the batch correlation invent one.
      const results = await runBatch(
        input.measureId,
        [{ subjectId: patientIdOf(input.patientBundle) ?? "", patientBundle: input.patientBundle }],
        input.evaluationDate,
      );
      const [only] = [...results.values()];
      if (!only) {
        throw new Error(`${input.measureId}: the official artifact returned no result for this subject`);
      }
      return only;
    },

    evaluateBatch: runBatch,
  };
}
