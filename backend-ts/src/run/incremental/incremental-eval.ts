/**
 * Incremental-evaluation orchestration (#263 Phase 2b) — ties the pure change-signal functions
 * (`canonical-hash`, `logic-version`, `next-transition`, `evidence-copy-forward`) to the `EvalStateStore`
 * and drives the per-subject "reuse or re-evaluate?" decision inside the run pipeline.
 *
 * Inert-unless-configured (the 10th seam, ADR-030 family): the pipeline only constructs an
 * `IncrementalCache` when `WORKWELL_INCREMENTAL_EVAL=true` AND an `evalState` store is present, so the
 * demo/default path is byte-identical to today. Scope is the live tenants only — the scale path
 * (`batch-evaluate-scale.ts`) is a different write choke point and is deliberately NOT wired here.
 *
 * Correctness contract (ADR-008): reuse only decides WHETHER to re-run CQL. On a hit it copies the prior
 * CQL outcome forward with date-corrected evidence; the CQL engine remains the sole author of every
 * status. A cache miss on ANY uncertainty (no row, hash/logic mismatch, past the transition date, source
 * outcome gone) falls back to a full evaluation — the cache can never produce a *wrong* answer, only a
 * *slower* run.
 */
import type { EvalStateStore } from "../../stores/eval-state-store.ts";
import type { OutcomeStore } from "../../stores/outcome-store.ts";
import { MEASURES, type MeasureMeta } from "../../engine/cql/measure-registry.ts";
import { ELM_LIBRARIES } from "../../engine/cql/elm/index.ts";
import { isVsacOid } from "../../engine/cql/composite-value-set-resolver.ts";
import { hashBundle } from "./canonical-hash.ts";
import { computeLogicVersion } from "./logic-version.ts";
import { computeNextTransition } from "./next-transition.ts";
import { recomputeEvidenceAsOf } from "./evidence-copy-forward.ts";

/** Env shape the incremental seam reads (inventory-tracked; ADR-030 family). */
export interface IncrementalEnv {
  WORKWELL_INCREMENTAL_EVAL?: string;
}

/** The seam predicate — the exact condition the pipeline's incremental path is gated on. */
export function isIncrementalEnabled(env: IncrementalEnv | undefined): boolean {
  return (env?.WORKWELL_INCREMENTAL_EVAL ?? "").trim().toLowerCase() === "true";
}

export interface IncrementalDeps {
  evalState: EvalStateStore;
  outcomes: Pick<OutcomeStore, "getOutcomeById">;
  /** The run's evaluation date, `YYYY-MM-DD`. */
  evalDate: string;
  /**
   * Whether a value-set RESOLVER is attached to the runtime engine (i.e. `isVsacConfigured(env)` — the
   * key-gated expansion path). It changes WHICH ELM library the engine executes for a measure that
   * declares non-OID value sets (base vs `expansionLibrary`), so it must feed `logic_version`. Default
   * `false` (the demo/scoped path — the engine runs the inline base library, byte-identical to before).
   */
  expansionActive?: boolean;
  /**
   * Store `expansion_hash` per value-set reference (canonical URL AND/OR OID → hash), built once per run
   * from `ValueSetStore.listAll()`. Folded into `logic_version` for a measure that expands, so a VSAC
   * re-import or an operator value-set edit (which moves the stored `expansion_hash`) invalidates reuse
   * (review #3 / Codex P1). Default empty — the scoped live tenants use inline `urn:workwell` codes with
   * no expansion, so nothing is folded and the result equals `hash(base ELM)`.
   */
  valueSetExpansionHashes?: ReadonlyMap<string, string>;
}

/** A reuse plan: copy this prior status/evidence forward instead of re-running CQL. */
export interface ReusePlan {
  action: "reuse";
  status: string;
  evidence: unknown;
  reusedFromRunId: string;
}
/** No reuse — evaluate, then `commit` with the fingerprint computed here (so the bundle is hashed once). */
export interface EvaluatePlan {
  action: "evaluate";
  dataHash: string;
  logicVersion: string;
}
export type Plan = ReusePlan | EvaluatePlan;

const key = (subjectId: string, measureId: string, period: string): string => `${subjectId}|${measureId}|${period}`;

/** Attach the copy-forward provenance marker without mutating the source evidence object (§7). */
function markReused(evidence: unknown, runId: string): unknown {
  if (evidence !== null && typeof evidence === "object") return { ...(evidence as Record<string, unknown>), reusedFrom: runId };
  return { reusedFrom: runId, original: evidence };
}

/**
 * Per-run incremental cache. One instance per population run; `plan` is called per (subject, measure)
 * before evaluation and `commit` after a real evaluation.
 */
export class IncrementalCache {
  private readonly byKey = new Map<string, import("../../stores/eval-state-store.ts").EvalStateRow>();
  private readonly primed = new Set<string>();
  private readonly logicCache = new Map<string, string>();

  constructor(private readonly deps: IncrementalDeps) {}

  /**
   * `logic_version` for a measure (cached per run) — hash of the ELM the engine ACTUALLY executes plus
   * the store expansion hashes of the value sets it expands. Mirrors `CqlExecutionEngine`'s library
   * selection exactly (base vs `expansionLibrary`), so a VSAC toggle, a re-import, or an operator
   * value-set edit all change the result and force re-evaluation (review #3 / Codex P1). Byte-identical
   * to `hash(base ELM)` on the scoped/demo path (no expansion active, no value-set hashes).
   */
  private async logicVersion(measureId: string): Promise<string> {
    const cached = this.logicCache.get(measureId);
    if (cached) return cached;
    const meta = MEASURES[measureId];
    if (!meta) {
      const lv = await computeLogicVersion({ unknownMeasure: measureId }, []);
      this.logicCache.set(measureId, lv);
      return lv;
    }
    const { libraryName, expand } = this.selectLibrary(meta);
    const elm = ELM_LIBRARIES[libraryName];
    // When the measure expands, fold in the store expansion_hash of each value set it references (by
    // canonical URL or bare OID). An OID with no store row (offline-bundled eCQM expansion) contributes
    // nothing — a narrow documented residual: it changes only with a redeploy of the vendored bundle, and
    // those measures (cms122/cms125) are non-boundary-safe (same-day-only reuse). urn:workwell references
    // resolve to their store expansion_hash when present.
    const map = this.deps.valueSetExpansionHashes;
    const expansionHashes: string[] = expand && map
      ? (meta.valueSets ?? [])
          .map((u) => map.get(u) ?? map.get(u.replace(/^urn:oid:/, "")))
          .filter((h): h is string => typeof h === "string" && h.length > 0)
      : [];
    const lv = await computeLogicVersion(elm ?? { missingElm: libraryName }, expansionHashes);
    this.logicCache.set(measureId, lv);
    return lv;
  }

  /** Replicate `CqlExecutionEngine`'s library selection (base vs expansion) for the current env. */
  private selectLibrary(meta: MeasureMeta): { libraryName: string; expand: boolean } {
    const wantsExpand = meta.valueSets != null && meta.valueSets.length > 0;
    const canExpandOffline = wantsExpand && meta.valueSets!.every((u) => /^(urn:oid:)?2\.16\./.test(u) || isVsacOid(u));
    const expand = wantsExpand && ((this.deps.expansionActive ?? false) || canExpandOffline);
    const libraryName = expand && meta.expansionLibrary != null ? meta.expansionLibrary : meta.library;
    return { libraryName, expand };
  }

  private async primeMeasure(measureId: string, period: string): Promise<void> {
    const pk = `${measureId}|${period}`;
    if (this.primed.has(pk)) return;
    this.primed.add(pk);
    for (const row of await this.deps.evalState.listEvalStatesForMeasurePeriod(measureId, period)) {
      this.byKey.set(key(row.subjectId, row.measureId, row.period), row);
    }
  }

  /**
   * Decide whether the prior outcome for (subject, measure, period) can be reused for the current run's
   * bundle + eval date. Returns a `ReusePlan` on a hit, else an `EvaluatePlan` carrying the fingerprint
   * (so the caller commits without re-hashing).
   */
  async plan(measureId: string, subjectId: string, period: string, bundle: unknown): Promise<Plan> {
    await this.primeMeasure(measureId, period);
    const [dataHash, logicVersion] = await Promise.all([hashBundle(bundle), this.logicVersion(measureId)]);
    const evaluate: EvaluatePlan = { action: "evaluate", dataHash, logicVersion };

    const row = this.byKey.get(key(subjectId, measureId, period));
    if (!row) return evaluate;
    if (row.dataHash !== dataHash || row.logicVersion !== logicVersion) return evaluate; // data or logic changed

    const { evalDate } = this.deps;
    // The whole next_transition_at scheme assumes the clock only moves FORWARD (days-since only grows as
    // Now() advances). A BACKDATED run (`evalDate < sourceEvalDate`) breaks that: a terminal row would
    // reuse unconditionally and a pre-boundary row would pass `evalDate < nextTransitionAt` too, copying a
    // status computed in the FUTURE into an earlier date (e.g. July's OVERDUE into a June rerun) — a wrong
    // answer a full run would not produce (Codex P1 / review #1). Rerunning an older run reuses its
    // persisted evaluationDate, so this is a normal path once a newer run has advanced the cache. Require
    // the source evaluation to be no later than the requested date; a backdated run then always
    // re-evaluates (correct + cheap). `>=` also subsumes the same-day case.
    const temporalOk =
      evalDate >= row.sourceEvalDate &&
      (row.nextTransitionAt === null || // terminal status on unchanged data
        evalDate < row.nextTransitionAt || // still before the status boundary
        row.sourceEvalDate === evalDate); // same-day reuse (covers non-boundary-safe measures)
    if (!temporalOk) return evaluate;

    const src = await this.deps.outcomes.getOutcomeById(row.sourceOutcomeId);
    if (!src) return evaluate; // source outcome gone (e.g. a rollback) — re-evaluate to be safe

    const evidence = recomputeEvidenceAsOf(src.evidence, row.sourceEvalDate, evalDate);
    return { action: "reuse", status: row.lastStatus, evidence: markReused(evidence, src.runId), reusedFromRunId: src.runId };
  }

  /**
   * Record the fingerprint of a REAL evaluation so a future run can reuse it. Call only after a
   * successful `engine.evaluate` (never for an engine-failure MISSING_DATA — we must not cache an error).
   */
  async commit(
    measureId: string,
    subjectId: string,
    period: string,
    status: string,
    sourceOutcomeId: string,
    evidence: unknown,
    fingerprint: { dataHash: string; logicVersion: string },
  ): Promise<void> {
    const nextTransitionAt = computeNextTransition(measureId, status, evidence, this.deps.evalDate);
    const row = {
      subjectId,
      measureId,
      period,
      dataHash: fingerprint.dataHash,
      logicVersion: fingerprint.logicVersion,
      nextTransitionAt,
      lastStatus: status,
      sourceOutcomeId,
      sourceEvalDate: this.deps.evalDate,
      lastEvaluatedAt: new Date().toISOString(),
    };
    await this.deps.evalState.upsertEvalState(row);
    // keep the in-run map current so a later item for the same key (unusual) sees the fresh fingerprint
    this.byKey.set(key(subjectId, measureId, period), { id: "", ...row });
  }
}
