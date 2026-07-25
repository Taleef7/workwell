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
 *   4. it is a `proportion` measure (the population mapping assumes a numerator exists); and
 *   5. every value set its ELM retrieves expands to a non-empty set.
 *
 * (5) is the one that would otherwise be invisible: fqm treats an unexpandable value set as *empty
 * rather than missing*, an empty set matches nothing, and the measure then reports every subject
 * out-of-population — which reads downstream exactly like a genuinely ineligible roster.
 *
 * 1-4 are reported TOGETHER, so an operator fixes them in one pass rather than one redeploy at a time.
 * (5) is checked afterwards and stops at the first failure — it costs a real expansion per measure, and
 * the first missing terminology is the one worth acting on.
 *
 * `worker.ts` runs 1-4 at BOOT as well, because everything here is lazy: a typo would otherwise boot
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
import { getStores, type StoresEnv } from "../stores/factory.ts";
import type { ValueSetStore } from "../stores/value-set-store.ts";
import type { VsacEnv } from "../engine/cql/resolve-value-set-resolver.ts";
import { OFFICIAL_GATED_MEASURES } from "../standards/official-cases.ts";
import { engineForEnv } from "./engine-factory.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import {
  officialMeasureExecutor,
  oidFromValueSetUrl,
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

/**
 * Expand a VSAC OID from the imported `value_sets` rows.
 *
 * One bounded catalog read, snapshotted for the expander's lifetime — which is the router's, which is
 * one run. `listAll()` rather than a per-OID query because the store has no OID lookup and the catalog
 * is dozens of rows; adding one would be a store-contract change for no gain at this size.
 */
export function storeValueSetExpander(valueSets: ValueSetStore): ExpandValueSet {
  let snapshot: Promise<Map<string, Array<{ code: string; system: string }>>> | undefined;
  const load = () => {
    snapshot ??= valueSets.listAll().then((rows) => {
      const byOid = new Map<string, Array<{ code: string; system: string }>>();
      for (const row of rows) {
        // The PACKAGE's normalization, not a second one that happens to agree on VSAC canonicals:
        // the expander is keyed by whatever `buildValueSetCache` passes in, and two rules that differ
        // on any other URL shape is a bug waiting for the first non-VSAC canonical.
        const oid = oidFromValueSetUrl(row.oid);
        byOid.set(oid, (row.codes ?? []).map((c) => ({ code: c.code, system: c.system })));
      }
      return byOid;
    });
    return snapshot;
  };
  return async (oid) => (await load()).get(oid) ?? [];
}

/** Everything wrong with the current `WORKWELL_OFFICIAL_MEASURES`, as sentences. Empty means legal. */
export function officialRoutingProblems(env: OfficialMeasuresEnv): string[] {
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
  }
  return problems;
}

export interface RoutedEngineOptions {
  /** Injectable for tests; defaults to the real store-backed expander. */
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

  const problems = officialRoutingProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `WORKWELL_OFFICIAL_MEASURES is not a valid configuration:\n  - ${problems.join("\n  - ")}`,
    );
  }

  const expand = options.expand ?? storeValueSetExpander((await getStores(env)).valueSets);
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
