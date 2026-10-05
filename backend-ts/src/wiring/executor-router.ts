/**
 * Per-measure execution routing (roadmap §7.2, PR-7b).
 *
 * `routedEngineForEnv(env)` returns the thing every caller already asks `engineForEnv(env)` for, except
 * that measures named in `WORKWELL_OFFICIAL_MEASURES` are evaluated by the OFFICIAL published artifact
 * instead of WorkWell's authored CQL. Nothing downstream changes shape: the run pipeline, the case
 * rerun path, the scheduler and the simulate route keep the exact call they make today.
 *
 * **Unset — every environment that exists right now — returns `engineForEnv(env)` itself**, not a
 * wrapper around it. Identity, not equivalence: there is no dispatch, no allocation, and nothing to
 * reason about on the default path. A parity test asserts it.
 *
 * ## Why the flag is a list and never "all"
 *
 * Flipping a measure to official execution changes what an operator is told about real people. It is a
 * deliberate per-measure act gated on a green MADiE test-case run, so the configuration is an explicit
 * allowlist. `WORKWELL_OFFICIAL_MEASURES=all` selects a measure called "all", which does not exist, and
 * is therefore refused — the same as any other typo.
 *
 * ## Everything is checked at CONSTRUCTION, and construction fails loudly
 *
 * A misconfiguration must not survive until the first subject is evaluated. By then a run is underway,
 * outcomes are being written, and the failure mode of most of these mistakes is silence rather than an
 * error. So the router refuses to exist unless, for every named measure:
 *
 *   1. the official MADiE gate covers it (`ungatedOfficialMeasures` — THE RULE, roadmap §7.4 PR-6);
 *   2. an executable artifact is vendored, and its `catalogId` matches;
 *   3. WorkWell has recorded what its numerator means (`official-measure-semantics.ts`);
 *   4. it is a `proportion` measure (the population mapping assumes a numerator exists);
 *   5. its terminology sidecar is present and matches the pin in its manifest (ADR-036);
 *   6. no value set its ELM retrieves is VSAC-capped (a partial expansion — see below);
 *   7. no value set its ELM DECLARES is ABSENT from the artifact entirely (ADR-053); and
 *   8. every value set its ELM retrieves expands to a non-empty set.
 *
 * (8) is the one that would otherwise be invisible: fqm treats an unexpandable value set as *empty
 * rather than missing*, an empty set matches nothing, and the measure then reports every subject
 * out-of-population — which reads downstream exactly like a genuinely ineligible roster.
 *
 * (6) is the same failure one notch weaker, and (8) cannot catch it: half-expanded is not empty. The
 * cap is UPSTREAM POLICY rather than a VSAC limit — the content repo ships every expansion truncated
 * at 1000 because full ones need an NLM licence — and the capped set in both vendored measures feeds a
 * denominator exclusion, so routing would leave excluded subjects in the denominator and score them.
 * **Both cms122 and cms125 failed this check until ADR-041**, deliberately; `vendor:official
 * --complete-terminology` (roadmap §7.3) now completes the shortfall from VSAC at vendor time and
 * both pass. The check stays live and tested: a re-vendor without the credential reinstates the refusal
 * rather than shipping a narrowed exclusion.
 *
 * (7) changes no routing DECISION — (8) already refuses it — and exists entirely to change the
 * diagnosis. "N of M value sets could not be expanded" reads as a failure of our sidecar, our pin or
 * our fetch; the actual condition is that upstream's bundle ships no ValueSet resource for the OID at
 * all, so no amount of re-vendoring at the same pin can help. That misdiagnosis is on the record as
 * ADR-047's "value set …3.526.3.1278 will not expand" — which ADR-047 itself flagged as a cause it
 * did not know.
 *
 * 1-7 are reported TOGETHER, so an operator fixes them in one pass rather than one redeploy at a time.
 * (8) is checked afterwards and stops at the first failure — it costs a real expansion per measure, and
 * the first missing terminology is the one worth acting on.
 *
 * `worker.ts` runs 1-7 at BOOT as well, because everything here is lazy: a typo would otherwise boot
 * clean, log `official-measures=on`, keep /actuator/health green, and 500 every evaluating route.
 *
 * ## Scope of this PR
 *
 * Ships dark. Bundle preparation (ADR-037), measure-major batching (PR-8, `evaluateBatch` below) and
 * the capped `AdvancedIllness` expansion in (6) (ADR-041) are all done, so cms122 and cms125 are now
 * ROUTABLE — which is not the same as routed. What remains before the flip is PR-9b: official routing
 * and the WebChart seam are not yet safe to configure together, because WebChart-derived data carries
 * neither the Conditions nor the Encounters an official Initial Population reads. The flag existing and
 * the flag being safe to set are still different things, which is why `WORKWELL_OFFICIAL_MEASURES`
 * remains deliberately absent from DEPLOY.md.
 *
 * Not every evaluation path is routed, and deliberately so while this is dark: the scale batch
 * (`run/batch-evaluate-scale.ts`), the seed CLIs, the DB-less `engine/ingress/evaluate-bundle.ts` and
 * the headless CLI all construct engines directly. PR-8/PR-9 must not assume coverage they do not have.
 */
import type { EvaluateMeasureBinding, EvaluateMeasureInput, MeasureOutcome } from "@work-well/measure-engine";
import type { MeasureMeta } from "../engine/cql/measure-registry.ts";
import type { StoresEnv } from "../stores/factory.ts";
import type { VsacEnv } from "@work-well/measure-engine";
import { OFFICIAL_GATED_MEASURES } from "../standards/official-cases.ts";
import { derivedIdentityProblems } from "../standards/derived-identity.ts";
import { engineForEnv } from "./engine-factory.ts";
import {
  artifactKind,
  loadDerivedArtifact,
  loadOfficialArtifact,
  selectArtifactForPeriod,
  type ArtifactKind,
  type DerivedManifestBlock,
  type OfficialArtifact,
} from "./official-artifacts.ts";
import {
  absentValueSets,
  cappedExpansions,
  loadOfficialTerminology,
  officialTerminologyExpander,
  type LoadedTerminology,
} from "./official-terminology.ts";
import {
  effectivePeriodWarning,
  officialMeasureExecutor,
  officialMeasurementPeriod,
  type OfficialBatchSubject,
  requiredOids,
  type ExpandValueSet,
  type FqmCalculate,
} from "./official-executor-adapter.ts";
import {
  derivedMeasureIds,
  officialMeasureIds,
  ungatedOfficialMeasures,
  type OfficialMeasuresEnv,
} from "./official-routing.ts";
import { officialMeasureSemantics } from "./official-measure-semantics.ts";
import { fqmWorkerCount, fqmWorkerEnabled, sharedFqmWorker, type BatchCalculator } from "./fqm-worker.ts";

/** The extended shape the authored engine accepts — diagnostics pass an explicit library to run. */
export type RoutableInput = EvaluateMeasureInput & { elm?: unknown; metaOverride?: MeasureMeta };

/**
 * The logic an engine executes for one measure ON ONE DATE: CMS's artifact, or a WorkWell translation for
 * a year CMS's does not cover. `version` is what a cache keys and the compliance API reports; `warning` is
 * the "scored with prior-year logic" sentence when the chosen artifact does not cover the year.
 */
export interface RoutedLogic {
  version: string;
  kind: ArtifactKind;
  /** The translation's label ("WorkWell translation of CMS137v15"); absent for CMS's artifact. */
  label?: string;
  warning: string | null;
}

/**
 * Whether a measure's outcome on that date comes from an fqm-executed artifact — CMS's or a WorkWell
 * translation — and so carries population membership: the out-of-population rule (ADR-078) and the
 * empty-population warning (ADR-043) apply. THE one predicate for that question: five call sites used to
 * test a string prefix each, and a translation with its own prefix would have slipped past all five and
 * opened a case for nearly every out-of-population patient.
 */
export function isFqmScored(logic: RoutedLogic | undefined): logic is RoutedLogic {
  return logic !== undefined && (logic.kind === "official" || logic.kind === "derived");
}

export interface RoutedEngine {
  evaluate(input: RoutableInput): Promise<MeasureOutcome>;
  /**
   * The LOGIC this engine executes for `measureId` on `evaluationDate`, when that logic is not WorkWell's
   * authored ELM. `undefined` means "authored" — the caller derives the identity the way it always has.
   *
   * The date is required, not optional: which artifact scores a measure depends on the year (decision 3),
   * so a caller that asked without one would get an answer about a year it did not evaluate. Named
   * `logicFor` rather than adding a parameter to the old `logicVersionFor` so every caller and every test
   * stub had to change — a one-argument stub still type-checks against a two-argument signature.
   *
   * This exists because of a correctness hazard in incremental evaluation (#263/ADR-035), not as a
   * convenience. `incremental-eval.ts` derives `logic_version` by hashing `ELM_LIBRARIES[libraryName]`
   * — the AUTHORED ELM — so a measure flipped to official execution would keep the SAME
   * `logic_version`, and the `eval_state` cache would copy authored outcomes forward for a measure now
   * running the official artifact. Re-vendoring that artifact would not invalidate them either.
   *
   * It hangs off the ENGINE rather than being passed alongside it deliberately. The alternative —
   * another optional field threaded through `RunPipelineDeps` from each caller — is the exact shape of
   * the bug PR-7b's review caught twice (a call site that forgot to pass the official flag, so the
   * nightly run used a different engine than the manual one). Here the logic identity and the thing
   * that computes the outcome are the same object, so they cannot disagree, and a new call site gets it
   * for free instead of having to remember it.
   */
  logicFor?(measureId: string, evaluationDate: string): RoutedLogic | undefined;

  /**
   * Evaluate one measure's whole roster in a single pass, or resolve `undefined` when this measure has
   * no batch path and the caller should evaluate per subject (roadmap §7.4 PR-8).
   *
   * The point is cost: fqm-execution parses the artifact's ELM per CALL, so a 150-subject official
   * measure was paying 150 parses of a 2.4 MB bundle for one measure's answer. The authored engine has
   * no equivalent saving — `cql-execution` is already per-subject — so it offers no batch path and every
   * caller keeps the per-subject loop it has today.
   *
   * `subjects` is a FACTORY, invoked only once the measure is known to be batchable. Passed eagerly, a
   * caller would build a roster of bundles for every measure and discard the 13 of 14 that are not
   * routed — the cost this method exists to remove, reintroduced at the call site.
   *
   * **One method, not a `canBatch()` predicate plus a call.** Two signals about the same fact drift; the
   * `undefined` resolution IS the predicate, decided by the same `official` set the dispatch below reads.
   * For the same reason it is deliberately NOT inferred from `logicFor(id, date) !== undefined` — "has
   * a declared logic identity" and "can be batched" happen to coincide today, and a coincidence relied
   * on is a coincidence that breaks quietly.
   *
   * Like `logicFor` it hangs off the ENGINE rather than being threaded alongside it, so a new
   * call site gets it for free instead of having to remember it (see that method's note).
   */
  evaluateBatch?(
    measureId: string,
    subjects: () => readonly OfficialBatchSubject[],
    evaluationDate?: string,
  ): Promise<Map<string, MeasureOutcome> | undefined>;
}

/**
 * The logic identity of a vendored official artifact: `official-fqm:<version>:<artifactSha>:<terminologySha>`.
 *
 * Deliberately a readable composite rather than the `sha256(...)` the roadmap sketched. Every input is
 * already a digest, so hashing them again buys no collision resistance — it only makes an `eval_state`
 * row unreadable at exactly the moment someone is asking "which artifact produced this?". The
 * `official-fqm:` prefix keeps it disjoint from the authored side's `sha256:<hex>` by construction, so
 * the two can never collide however the authored hash is computed.
 *
 * The terminology digest is in for a reason the roadmap's sketch missed: the executor retrieves against
 * the artifact's OWN expansions (ADR-036), which are fetched at build and pinned in the committed
 * manifest. Re-fetching at a different upstream ref can move value-set membership — and therefore
 * outcomes — with the bundle bytes unchanged. Version + artifact sha alone would call that "same logic".
 * An artifact vendored before PR-8a carries no terminology block; `unpinned` records that honestly, and
 * such a measure cannot be routed anyway (the router refuses it).
 */
export function officialLogicVersion(artifact: OfficialArtifact): string {
  const { version, sha256, terminology } = artifact.manifest;
  const prefix = artifactKind(artifact) === "derived" ? DERIVED_LOGIC_VERSION_PREFIX : OFFICIAL_LOGIC_VERSION_PREFIX;
  return `${prefix}${version}:${sha256}:${terminology?.sha256 ?? "unpinned"}`;
}

/**
 * The prefixes that mark a logic identity as CMS's artifact (`official-fqm:`) or a WorkWell translation
 * (`derived-fqm:`), keeping both disjoint from the authored side's `sha256:<hex>`. Written here and read
 * nowhere else: "is this fqm-scored?" is `isFqmScored`, never a prefix test at the call site.
 */
const OFFICIAL_LOGIC_VERSION_PREFIX = "official-fqm:";
const DERIVED_LOGIC_VERSION_PREFIX = "derived-fqm:";

/** The checks a translation must have passed, each against this exact artifact and terminology. */
export const REQUIRED_DERIVED_ORACLES = ["cypress-deck", "terminology-equivalence"] as const;

export interface RoutingCheckDeps {
  /**
   * Injectable for tests. It has to be: the terminology sidecar is FETCHED AT BUILD and gitignored, so
   * whether `cms122` is fully routable is a fact about the working tree, not about the code. The
   * default offline suite asserts the checks, not the build artifact; `official-terminology.test.ts`
   * asserts the real file and self-skips without it, and the `official-cases` CI job — which vendors
   * the sidecar — runs that file explicitly for exactly this reason.
   */
  loadTerminology?: (artifact: OfficialArtifact) => LoadedTerminology;
  /**
   * Injectable for the same reason, and one more: since ADR-041 neither vendored artifact carries a
   * capped expansion, so a test that only ever saw the real ones would assert nothing here. Stubbing it
   * NON-empty is what proves the refusal still fires; stubbing it empty is what lets a test reach a
   * later check. Both are honest where relaxing the check would not be.
   */
  cappedFor?: (artifact: OfficialArtifact) => Array<{ oid: string; have: number; declaredTotal: number }>;
  /**
   * Injectable for the same reasons again, and sharply so: no VENDORED artifact has an absent value set
   * — the one measure that does (CMS138) is deliberately not vendored, precisely because it cannot run.
   * A test that only ever saw `measures/official/` would therefore assert an empty list against an empty
   * list forever and read as covering this. Stubbing it non-empty is the only way to prove the refusal
   * fires at all.
   */
  absentFor?: (artifact: OfficialArtifact) => string[];
  /** Injectable for tests, which supply their own translation rather than reading the committed one. */
  loadDerived?: (catalogId: string) => OfficialArtifact | null;
}

/** Everything wrong with the current `WORKWELL_OFFICIAL_MEASURES`, as sentences. Empty means legal. */
export function officialRoutingProblems(env: OfficialMeasuresEnv, deps: RoutingCheckDeps = {}): string[] {
  const loadTerminology = deps.loadTerminology ?? loadOfficialTerminology;
  const cappedFor = deps.cappedFor ?? ((artifact) => cappedExpansions(artifact, requiredOids(artifact)));
  const absentFor =
    deps.absentFor ?? ((artifact) => absentValueSets(artifact, requiredOids(artifact), loadTerminology));
  const problems: string[] = [];
  for (const id of ungatedOfficialMeasures([...OFFICIAL_GATED_MEASURES], env as Record<string, unknown>)) {
    problems.push(
      `${id}: not covered by the official MADiE test-case gate — no measure may be routed officially ` +
        `without external validation (roadmap §7.4 PR-6)`,
    );
  }
  for (const id of officialMeasureIds(env as Record<string, unknown>)) {
    const artifact = loadOfficialArtifact(id);
    if (!artifact) {
      problems.push(`${id}: no executable official artifact is vendored (see measures/official/)`);
      continue;
    }
    if (artifact.manifest.catalogId !== id) {
      problems.push(`${id}: the vendored artifact declares catalogId '${artifact.manifest.catalogId}'`);
    }
    // Scoring was the ONE adapter refusal that fired per-subject rather than here — and the run
    // pipeline error-isolates a per-subject throw into MISSING_DATA, so a non-proportion artifact
    // would produce a *successful* population run in which every subject is MISSING_DATA. That is the
    // silent-empty-population failure the terminology preflight exists to prevent, through the door
    // next to it.
    if (artifact.manifest.scoring !== "proportion") {
      problems.push(
        `${id}: scoring '${artifact.manifest.scoring}' is not supported — the population mapping ` +
          `assumes a proportion measure (a cohort measure has no numerator at all)`,
      );
    }
    // EPISODE-OF-CARE measures cannot be executed by this adapter (review, #358). CMS68 declares
    // `populationBasis: "Encounter"`: one patient with N qualifying encounters is N denominator units,
    // and `outcomeFromPopulations` maps exactly one boolean vector per SUBJECT. Routing it would collapse
    // four office visits into one COMPLIANT/OVERDUE, so MeasureReport would count subjects where the
    // measure counts encounters — a wrong denominator with nothing to signal it, which is the same silent
    // shape ADR-043 exists for.
    //
    // The MADiE deck provably cannot catch this: all 19 CMS68 cases have a max expected count of 1 for
    // every population and not one subject produces more than one episode, so 19/19 is evidence about
    // single-encounter patients only. A green gate is exactly why this needs a construction-time refusal
    // rather than a note.
    if (artifact.manifest.populationBasis && artifact.manifest.populationBasis !== "boolean") {
      problems.push(
        `${id}: populationBasis '${artifact.manifest.populationBasis}' is an EPISODE-OF-CARE measure — ` +
          `the executor maps one population vector per subject, so a subject with several qualifying ` +
          `episodes would be counted once. Episode support is unbuilt; routing this measure would report ` +
          `a wrong denominator with no signal.`,
      );
    }
    if (!officialMeasureSemantics(id)) {
      problems.push(
        `${id}: no recorded numerator semantics — see official-measure-semantics.ts. There is no safe ` +
          `default: guessing one way reports every failure as compliant, the other every success as overdue`,
      );
    }
    // Reported HERE rather than left to the expansion refusal below, which would otherwise render a
    // missing sidecar as "26 of 26 value sets could not be expanded" — true, but it sends an operator
    // looking for 26 separate terminology problems instead of the one build step that produces all of
    // them. Same reason `scoring` moved up: a precise sentence at boot beats an accurate one later.
    const terminology = loadTerminology(artifact);
    if (!terminology.ok) problems.push(terminology.problem);

    // A CAPPED expansion is the failure one notch weaker than an empty one, and preflight cannot see
    // it: `expandArtifactTerminology` refuses on empty, and a half-expanded set is not empty. UPSTREAM
    // caps every expansion it ships at 1000 codes (its README says so — full ones need an NLM licence,
    // so this is policy rather than a defect), and the capped set in both vendored measures feeds a
    // DENEX — so routing would leave excluded subjects in the denominator and score them.
    // Recorded-and-warned was the state this check replaces; a warning printed at vendor time is long
    // gone by the time anyone sets the flag. The remedy is now one command, so it is named here.
    for (const cap of cappedFor(artifact)) {
      problems.push(
        `${id}: value set ${cap.oid} expands to only ${cap.have} of ${cap.declaredTotal} codes ` +
          `(upstream caps its shipped expansions at 1000) and this measure's ELM retrieves it. Routing ` +
          `would narrow populations silently — re-vendor with ` +
          `\`pnpm vendor:official --measure <name> --catalog-id ${id} --strip-elm-annotations ` +
          `--complete-terminology\` and WORKWELL_VSAC_API_KEY set (ADR-041, DEPLOY.md "Step 1a").`,
      );
    }
    // ABSENT is a third condition, weaker than capped and stronger than empty: the artifact holds no
    // terminology for this OID because the upstream bundle shipped no ValueSet resource for it
    // (ADR-053; CMS138 declares 32 value sets and ships 31).
    //
    // "DECLARED", not "retrieved", and the distinction is not pedantic — review of #364 measured that
    // CMS138's ELM contains **zero** `ValueSetRef`/`Retrieve` references to the absent OID: it is a
    // `valueset` declaration the CQL never uses. The refusal is still right, because fqm reads
    // `Library.relatedArtifact`/`dataRequirement` (which DOES list it) and throws `Missing the following
    // valuesets`. So this check OVER-APPROXIMATES on purpose — a declared-but-unused value set is
    // refused too — and that is the safe direction, but the message must not assert a retrieval that
    // does not happen.
    //
    // Reported HERE for the same reason `scoring` and the sidecar check moved up — the expansion
    // refusal below already catches it, but says "N of M value sets could not be expanded", which sends
    // an operator at our sidecar, our pin and our fetch. None of those is the cause, and that exact
    // misdiagnosis is on the record as ADR-047's "value set …3.526.3.1278 will not expand". This
    // changes no routing decision; it changes what the operator is told, which is the whole cost of the
    // week that finding sat open.
    for (const oid of absentFor(artifact)) {
      problems.push(
        `${id}: value set ${oid} is declared by this measure's ELM but the upstream bundle ships no ` +
          `ValueSet resource for it, so the artifact holds no codes for it at all. This is not an ` +
          `expansion failure and re-pinning will not fix it — source it from VSAC with ` +
          `\`pnpm vendor:official --measure <name> --catalog-id ${id} --strip-elm-annotations ` +
          `--complete-terminology\` and WORKWELL_VSAC_API_KEY set (ADR-053, DEPLOY.md "Step 1a").`,
      );
    }
  }
  problems.push(...derivedRoutingProblems(env, { loadTerminology, cappedFor, absentFor, loadDerived: deps.loadDerived ?? loadDerivedArtifact }));
  return problems;
}

/**
 * Everything wrong with `WORKWELL_DERIVED_MEASURES` (decision 3). A translation may score a year only if
 * it is everything CMS's artifact is — gated, proportion, same populations — plus a translation's own
 * guarantees. Reported together with the official problems, so the router refuses either way.
 *
 *   D1 the measure is also official-routed: a translation stands in for one year, never for the measure;
 *   D2 a translation is committed under measures/derived/<id>/ and its catalogId matches;
 *   D3 its identity is WorkWell's (`derivedIdentityProblems`) — no CMS identity over its counts (§4.3);
 *   D4 it covers exactly one calendar year, so it can never run outside the year it was checked for;
 *   D5 its terminology names the VSAC release it was expanded from;
 *   D6 its scoring, population basis, populations, improvement notation, group and stratifier ids equal
 *      CMS's — the semantics table, case logic and MeasureReport strata are all keyed by the measure;
 *   D7 every required check passed, against THIS artifact's hash and THIS terminology's hash, over exactly
 *      one calendar year — and the terminology check over the translation's own year: value sets are
 *      bound to the year they score. The deck check's year is the deck's own (`oraclePeriodProblems`);
 *   D8 its terminology sidecar is present, matches its pin, and is neither capped nor missing a set;
 *   D9 its bundle holds only a Measure and Libraries: an embedded ValueSet would outrank its sidecar.
 */
function derivedRoutingProblems(
  env: OfficialMeasuresEnv,
  deps: {
    loadTerminology: (artifact: OfficialArtifact) => LoadedTerminology;
    cappedFor: (artifact: OfficialArtifact) => Array<{ oid: string; have: number; declaredTotal: number }>;
    absentFor: (artifact: OfficialArtifact) => string[];
    loadDerived: (catalogId: string) => OfficialArtifact | null;
  },
): string[] {
  const problems: string[] = [];
  const official = officialMeasureIds(env as Record<string, unknown>);
  for (const id of derivedMeasureIds(env as Record<string, unknown>)) {
    if (!official.has(id)) {
      problems.push(`${id}: named in WORKWELL_DERIVED_MEASURES but not in WORKWELL_OFFICIAL_MEASURES — a translation only ever stands in for a routed measure's CMS artifact`);
      continue;
    }
    const translation = deps.loadDerived(id);
    if (!translation) {
      problems.push(`${id}: no executable translation is committed (see measures/derived/)`);
      continue;
    }
    const manifest = translation.manifest;
    if (manifest.catalogId !== id) problems.push(`${id}: the translation declares catalogId '${manifest.catalogId}'`);
    const base = loadOfficialArtifact(id);
    problems.push(...derivedIdentityProblems(translation.bundle as never, manifest, base));
    // D9: only a Measure and its Libraries. fqm puts a bundle's own ValueSets into its code service ahead
    // of the sidecar's, and an embedded versioned expansion outranks the sidecar's unversioned one — so a
    // translation built from CMS's raw bundle would score 2027 with CMS's 2026 codes, silently.
    const entries = (translation.bundle as { entry?: Array<{ resource?: { resourceType?: string } }> }).entry ?? [];
    const stray = [...new Set(entries.map((e) => String(e.resource?.resourceType)).filter((t) => t !== "Measure" && t !== "Library"))];
    if (stray.length > 0) {
      problems.push(`${id}: the translated bundle carries ${stray.join(", ")} resources; only a Measure and its Libraries may be committed, because an embedded ValueSet outranks the translation's own expansion`);
    }

    const ep = manifest.effectivePeriod;
    const year = ep?.start?.slice(0, 4);
    if (!ep?.start || !ep?.end || ep.start.slice(0, 10) !== `${year}-01-01` || ep.end.slice(0, 10) !== `${year}-12-31`) {
      problems.push(`${id}: a translation must cover exactly one calendar year; it declares ${ep?.start ?? "?"}..${ep?.end ?? "?"}`);
    }
    // The selector trusts the MANIFEST's period, so it must be the period the translated Measure was built
    // and checked for: a manifest edited to another year would otherwise run 2027 logic in that year.
    const measurePeriod = (entries.find((e) => e.resource?.resourceType === "Measure")?.resource as { effectivePeriod?: { start?: string; end?: string } } | undefined)?.effectivePeriod;
    if (measurePeriod?.start?.slice(0, 10) !== ep?.start?.slice(0, 10) || measurePeriod?.end?.slice(0, 10) !== ep?.end?.slice(0, 10)) {
      problems.push(
        `${id}: the manifest declares ${ep?.start ?? "?"}..${ep?.end ?? "?"} but the translated Measure's effectivePeriod is ` +
          `${measurePeriod?.start ?? "?"}..${measurePeriod?.end ?? "?"}; a translation is chosen only for the year it was built for`,
      );
    }
    if (!manifest.terminology?.completion?.manifest) {
      problems.push(`${id}: the translation's terminology does not name the VSAC release it was expanded from`);
    }

    if (base) {
      for (const field of ["scoring", "populationBasis", "improvementNotation"] as const) {
        if (manifest[field] !== base.manifest[field]) {
          problems.push(`${id}: the translation's ${field} '${manifest[field]}' differs from CMS's '${base.manifest[field]}'`);
        }
      }
      if (JSON.stringify(manifest.populations) !== JSON.stringify(base.manifest.populations)) {
        problems.push(`${id}: the translation declares populations ${JSON.stringify(manifest.populations)}, CMS's ${JSON.stringify(base.manifest.populations)}`);
      }
      const shape = (artifact: OfficialArtifact) => JSON.stringify(groupShape(artifact));
      if (shape(translation) !== shape(base)) {
        problems.push(`${id}: the translation's group and stratifier ids differ from CMS's — every read of strata and rates is keyed by them`);
      }
    }

    const oracles = manifest.derived?.oracles ?? [];
    for (const name of REQUIRED_DERIVED_ORACLES) {
      const record = oracles.find((o) => o.name === name);
      if (!record || record.result !== "pass" || record.total <= 0 || record.agree !== record.total) {
        problems.push(`${id}: the translation has no passing '${name}' check`);
      } else if (record.ranAgainst.artifactSha256 !== manifest.sha256 || record.ranAgainst.terminologySha256 !== manifest.terminology?.sha256) {
        problems.push(`${id}: the translation's '${name}' check ran against a different artifact or terminology than the one committed`);
      }
      if (record) problems.push(...oraclePeriodProblems(id, record, ep));
    }

    const terminology = deps.loadTerminology(translation);
    if (!terminology.ok) problems.push(`${id} (translation): ${terminology.problem}`);
    for (const cap of deps.cappedFor(translation)) {
      problems.push(`${id} (translation): value set ${cap.oid} expands to only ${cap.have} of ${cap.declaredTotal} codes`);
    }
    for (const oid of deps.absentFor(translation)) {
      problems.push(`${id} (translation): value set ${oid} is declared but the translation's terminology holds no codes for it`);
    }
  }
  return problems;
}

/**
 * D7's period rules for one check record. Every record covers exactly one calendar year: a check over a
 * span or a fragment of a year is not a measurement-year check at all.
 *
 * Beyond that the two required checks prove different things, so their periods mean different things:
 *   - `terminology-equivalence` proves the translation's CODES, and value sets are bound to the year they
 *     score — so it must have run over the translation's own `effectivePeriod`, or it proved some other
 *     year's codes;
 *   - `cypress-deck` proves the LOGIC, and its period is the deck's own (2025 for the deck CMS137v15 is
 *     checked against): the deck's expected results exist only for the year they were written for, fqm
 *     takes the period from the call rather than from `Measure.effectivePeriod`, and shifting the
 *     patients' dates to another year would invent clinical data. The logic is period-independent (the
 *     period is a parameter it is called with); the codes are not, which is what the terminology check is for.
 * Read defensively: a hand-edited record missing its period is a sentence, never an exception here.
 */
function oraclePeriodProblems(
  id: string,
  record: DerivedManifestBlock["oracles"][number],
  effectivePeriod: { start?: string; end?: string } | null | undefined,
): string[] {
  const start = record.period?.start;
  const end = record.period?.end;
  const year = typeof start === "string" ? start.slice(0, 4) : "";
  const span = `${start ?? "?"}..${end ?? "?"}`;
  const problems: string[] = [];
  if (!/^\d{4}$/.test(year) || start !== `${year}-01-01` || end !== `${year}-12-31`) {
    problems.push(
      `${id}: the translation's '${record.name}' check ran over ${span}, which is not one calendar year` +
        (record.name === "cypress-deck" ? " (a deck's year may differ from the translation's, but it is one measurement year)" : ""),
    );
  }
  if (record.name === "terminology-equivalence") {
    const own = `${effectivePeriod?.start?.slice(0, 10) ?? "?"}..${effectivePeriod?.end?.slice(0, 10) ?? "?"}`;
    if (span !== own) {
      problems.push(
        `${id}: the translation's 'terminology-equivalence' check ran over ${span}, not the translation's own ${own}: ` +
          "unlike the deck's logic check, it proves value sets, and value sets are bound to the year they score",
      );
    }
  }
  return problems;
}

/** Each group's id with its stratifier ids — the keys rates and strata are read by. */
function groupShape(artifact: OfficialArtifact): Array<{ id: unknown; strata: unknown[] }> {
  const measure = ((artifact.bundle as { entry?: Array<{ resource?: Record<string, unknown> }> }).entry ?? [])
    .map((e) => e.resource)
    .find((r) => r?.["resourceType"] === "Measure");
  const groups = (measure?.["group"] as Array<{ id?: unknown; stratifier?: Array<{ id?: unknown }> }> | undefined) ?? [];
  return groups.map((g) => ({ id: g.id, strata: (g.stratifier ?? []).map((s) => s.id) }));
}

export interface RoutedEngineOptions extends RoutingCheckDeps {
  /** Injectable for tests; defaults to the artifact's own vendored terminology. */
  expand?: ExpandValueSet;
  /** Injectable for tests; defaults to the authored CQL engine. */
  authored?: EvaluateMeasureBinding;
  /** Injectable for tests; defaults to the real (lazily imported) fqm calculator. */
  calculate?: FqmCalculate;
  /** Where the calculation runs. Defaults to the process's worker thread (#604) unless `WORKWELL_FQM_WORKER=off`. */
  calculateBatch?: BatchCalculator;
  /** Routed, not swallowed: the run pipeline appends each warning as a WARN run-log line. */
  onWarning?: (message: string) => void;
}

export async function routedEngineForEnv(
  env: StoresEnv & VsacEnv & OfficialMeasuresEnv,
  options: RoutedEngineOptions = {},
): Promise<RoutedEngine> {
  const authored = options.authored ?? (await engineForEnv(env));
  const official = officialMeasureIds(env as Record<string, unknown>);
  // Identity on the default path — the wrapper below never exists in any environment today. A
  // translation allowlist with no official one is NOT that path: it is a misconfiguration (D1), and
  // returning the authored engine here would score the measure with the wrong logic and say nothing.
  if (official.size === 0 && derivedMeasureIds(env as Record<string, unknown>).size === 0) return authored as RoutedEngine;

  const problems = officialRoutingProblems(env, options);
  if (problems.length > 0) {
    throw new Error(
      `WORKWELL_OFFICIAL_MEASURES is not a valid configuration:\n  - ${problems.join("\n  - ")}`,
    );
  }

  // The artifact's OWN terminology, at the commit its ELM came from — never our VSAC import. That is
  // what makes the MADiE gate evidence about this path rather than about a configuration nothing runs
  // (roadmap §7.3; the split is documented at length in official-terminology.ts).
  const expand = options.expand ?? officialTerminologyExpander();

  // ONE decision about which artifact scores a measure for a period, shared by the executor (what runs)
  // and `logicFor` (what is reported and cached), so the two can never describe different logic. A
  // translation is a candidate only for a measure named in WORKWELL_DERIVED_MEASURES, and the checks
  // above have already refused any translation that is not fit to be one.
  const derivedIds = derivedMeasureIds(env as Record<string, unknown>);
  const loadDerived = options.loadDerived ?? loadDerivedArtifact;
  const candidates = (measureId: string) => ({
    official: loadOfficialArtifact(measureId),
    derived: derivedIds.has(measureId) ? loadDerived(measureId) : null,
  });
  const select = (measureId: string, period: { start: string; end: string }) => selectArtifactForPeriod(candidates(measureId), period);

  const executor = officialMeasureExecutor({
    expand,
    selectArtifact: select,
    candidateArtifacts: (measureId) => {
      const { official: base, derived } = candidates(measureId);
      return [base, derived].filter((a): a is OfficialArtifact => a !== null);
    },
    ...(options.calculate ? { calculate: options.calculate } : {}),
    ...(options.calculateBatch
      ? { calculateBatch: options.calculateBatch }
      : fqmWorkerEnabled(env as Record<string, unknown>)
        ? { calculateBatch: sharedFqmWorker(fqmWorkerCount(env as Record<string, unknown>)).calculate }
        : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
  });
  // Terminology, up front. Serially rather than in parallel: these hit the same snapshot and the first
  // failure is the one worth reporting, unqualified by a race.
  for (const id of official) await executor.preflight(id);

  // Checked once, here, against the same artifacts the executor was just built over. Unreachable —
  // `officialRoutingProblems` above already refused a missing artifact, and the load is memoized so the
  // second call cannot fail where the first succeeded. It throws anyway rather than skipping, because a
  // skip is the precise hazard the logic identity exists to close: `evaluate` would still route the
  // measure officially (it consults `official`) while `logicFor` reported "authored", and the cache would
  // record the authored ELM's hash for officially-produced outcomes. Silence is the one failure mode this
  // file does not accept.
  for (const id of official) {
    if (!loadOfficialArtifact(id)) throw new Error(`${id}: routing validated but the official artifact could not be loaded`);
  }

  return {
    /**
     * Keyed by measure and DATE, which matches how a cache keys logic. It does NOT account for the
     * per-INPUT `elm`/`metaOverride` escape below, under which a routed measure is evaluated authored.
     * That is sound only because the two callers cannot meet: the escape is used by the fidelity lab
     * and the Rule Builder, neither of which is a population run, and the incremental cache exists
     * only inside `finishManualRun`. A future caller that both overrides the library AND caches must
     * key on the library it asked for, not on the measure.
     */
    logicFor(measureId: string, evaluationDate: string): RoutedLogic | undefined {
      if (!official.has(measureId)) return undefined;
      const period = officialMeasurementPeriod(measureId, evaluationDate);
      const artifact = select(measureId, period);
      if (!artifact) throw new Error(`${measureId}: routing validated but no artifact covers ${period.start}..${period.end}`);
      const label = artifact.manifest.derived?.label;
      return {
        version: officialLogicVersion(artifact),
        kind: artifactKind(artifact),
        ...(label && artifactKind(artifact) === "derived" ? { label } : {}),
        warning: effectivePeriodWarning(artifact, period),
      };
    },
    async evaluateBatch(
      measureId: string,
      subjects: () => readonly OfficialBatchSubject[],
      evaluationDate?: string,
    ): Promise<Map<string, MeasureOutcome> | undefined> {
      // Refuse BEFORE calling the factory. Building a roster of bundles for a measure that turns out not
      // to be routed is pure waste, and with 14 runnable measures it is 13/14 of the work (review #3).
      if (!official.has(measureId)) return undefined;
      return executor.evaluateBatch(measureId, subjects(), evaluationDate);
    },
    async evaluate(input: RoutableInput): Promise<MeasureOutcome> {
      // An explicit `elm`/`metaOverride` means "run THIS library", so honouring it is the only correct
      // behaviour — routing it to the official executor would silently run a different measure than the
      // caller asked for. No production caller passes either today (the fidelity lab builds its own
      // engine directly), so this is a guard against a future caller, not a fix for a current one.
      const overridden = input.elm !== undefined || input.metaOverride !== undefined;
      return official.has(input.measureId) && !overridden
        ? executor.evaluate(input)
        : authored.evaluate(input);
    },
  };
}
