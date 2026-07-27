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
 *   6. no value set its ELM retrieves is VSAC-capped (a partial expansion — see below); and
 *   7. every value set its ELM retrieves expands to a non-empty set.
 *
 * (7) is the one that would otherwise be invisible: fqm treats an unexpandable value set as *empty
 * rather than missing*, an empty set matches nothing, and the measure then reports every subject
 * out-of-population — which reads downstream exactly like a genuinely ineligible roster.
 *
 * (6) is the same failure one notch weaker, and (7) cannot catch it: half-expanded is not empty. VSAC
 * caps expansions at 1000 codes, and the capped set in both vendored measures feeds a denominator
 * exclusion — so routing would leave excluded subjects in the denominator and score them. **Both
 * cms122 and cms125 currently fail this check**, deliberately: completing that expansion is a
 * vendor-time owner action (roadmap §4.3), and until it happens neither measure may be routed.
 *
 * 1-6 are reported TOGETHER, so an operator fixes them in one pass rather than one redeploy at a time.
 * (7) is checked afterwards and stops at the first failure — it costs a real expansion per measure, and
 * the first missing terminology is the one worth acting on.
 *
 * `worker.ts` runs 1-6 at BOOT as well, because everything here is lazy: a typo would otherwise boot
 * clean, log `official-measures=on`, keep /actuator/health green, and 500 every evaluating route.
 *
 * ## Scope of this PR
 *
 * Ships dark. It also does NOT yet prepare bundles (`stampQiCoreStructure`, see the adapter's docstring)
 * or batch subjects measure-major, so it must not be flipped on for a population run until PR-8 wires
 * both. The flag existing and the flag being safe to set are different things, and this PR only delivers
 * the first — which is why `WORKWELL_OFFICIAL_MEASURES` is deliberately absent from DEPLOY.md.
 *
 * Not every evaluation path is routed, and deliberately so while this is dark: the scale batch
 * (`run/batch-evaluate-scale.ts`), the seed CLIs, the DB-less `engine/ingress/evaluate-bundle.ts` and
 * the headless CLI all construct engines directly. PR-8/PR-9 must not assume coverage they do not have.
 */
import type { EvaluateMeasureBinding, EvaluateMeasureInput, MeasureOutcome } from "../engine/evaluate-measure.ts";
import type { MeasureMeta } from "../engine/cql/measure-registry.ts";
import type { StoresEnv } from "../stores/factory.ts";
import type { VsacEnv } from "../engine/cql/resolve-value-set-resolver.ts";
import { OFFICIAL_GATED_MEASURES } from "../standards/official-cases.ts";
import { engineForEnv } from "./engine-factory.ts";
import { loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";
import {
  cappedExpansions,
  loadOfficialTerminology,
  officialTerminologyExpander,
  type LoadedTerminology,
} from "./official-terminology.ts";
import {
  officialMeasureExecutor,
  requiredOids,
  type ExpandValueSet,
  type FqmCalculate,
} from "./official-executor-adapter.ts";
import {
  officialMeasureIds,
  ungatedOfficialMeasures,
  type OfficialMeasuresEnv,
} from "./official-routing.ts";
import { officialMeasureSemantics } from "./official-measure-semantics.ts";

/** The extended shape the authored engine accepts — diagnostics pass an explicit library to run. */
export type RoutableInput = EvaluateMeasureInput & { elm?: unknown; metaOverride?: MeasureMeta };

export interface RoutedEngine {
  evaluate(input: RoutableInput): Promise<MeasureOutcome>;
}

export interface RoutingCheckDeps {
  /**
   * Injectable for tests. It has to be: the terminology sidecar is FETCHED AT BUILD and gitignored, so
   * whether `cms122` is fully routable is a fact about the working tree, not about the code. The
   * default offline suite asserts the checks, not the build artifact; `official-terminology.test.ts`
   * asserts the real file and self-skips without it, and the `official-cases` CI job — which fetches
   * the sidecar — runs that file explicitly for exactly this reason.
   */
  loadTerminology?: (artifact: OfficialArtifact) => LoadedTerminology;
  /**
   * Injectable for the same reason, and one more: both vendored artifacts currently DO carry a capped
   * expansion, so this check legitimately refuses cms122/cms125 today. A test exercising a later check
   * has to get past it, and stubbing it is honest where relaxing the check would not be.
   */
  cappedFor?: (artifact: OfficialArtifact) => Array<{ oid: string; have: number; declaredTotal: number }>;
}

/** Everything wrong with the current `WORKWELL_OFFICIAL_MEASURES`, as sentences. Empty means legal. */
export function officialRoutingProblems(env: OfficialMeasuresEnv, deps: RoutingCheckDeps = {}): string[] {
  const loadTerminology = deps.loadTerminology ?? loadOfficialTerminology;
  const cappedFor = deps.cappedFor ?? ((artifact) => cappedExpansions(artifact, requiredOids(artifact)));
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
    // it: `expandArtifactTerminology` refuses on empty, and a half-expanded set is not empty. VSAC caps
    // at 1000 codes, and the capped set in both vendored measures feeds a DENEX — so routing would
    // leave excluded subjects in the denominator and score them. Recorded-and-warned was the state
    // this check replaces; a warning printed at vendor time is long gone by the time anyone sets the flag.
    for (const cap of cappedFor(artifact)) {
      problems.push(
        `${id}: value set ${cap.oid} expands to only ${cap.have} of ${cap.declaredTotal} codes ` +
          `(VSAC caps expansions at 1000) and this measure's ELM retrieves it. Routing would narrow ` +
          `populations silently — complete the expansion from VSAC at vendor time first (roadmap §4.3).`,
      );
    }
  }
  return problems;
}

export interface RoutedEngineOptions extends RoutingCheckDeps {
  /** Injectable for tests; defaults to the artifact's own vendored terminology. */
  expand?: ExpandValueSet;
  /** Injectable for tests; defaults to the authored CQL engine. */
  authored?: EvaluateMeasureBinding;
  /** Injectable for tests; defaults to the real (lazily imported) fqm calculator. */
  calculate?: FqmCalculate;
}

export async function routedEngineForEnv(
  env: StoresEnv & VsacEnv & OfficialMeasuresEnv,
  options: RoutedEngineOptions = {},
): Promise<RoutedEngine> {
  const authored = options.authored ?? (await engineForEnv(env));
  const official = officialMeasureIds(env as Record<string, unknown>);
  // Identity on the default path — the wrapper below never exists in any environment today.
  if (official.size === 0) return authored as RoutedEngine;

  const problems = officialRoutingProblems(env, options);
  if (problems.length > 0) {
    throw new Error(
      `WORKWELL_OFFICIAL_MEASURES is not a valid configuration:\n  - ${problems.join("\n  - ")}`,
    );
  }

  // The artifact's OWN terminology, at the commit its ELM came from — never our VSAC import. That is
  // what makes the MADiE gate evidence about this path rather than about a configuration nothing runs
  // (roadmap §4.3; the split is documented at length in official-terminology.ts).
  const expand = options.expand ?? officialTerminologyExpander(loadOfficialArtifact);
  const executor = officialMeasureExecutor({
    expand,
    ...(options.calculate ? { calculate: options.calculate } : {}),
  });
  // Terminology, up front. Serially rather than in parallel: these hit the same snapshot and the first
  // failure is the one worth reporting, unqualified by a race.
  for (const id of official) await executor.preflight(id);

  return {
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
