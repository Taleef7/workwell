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
import { MEASURES } from "../../engine/cql/measure-registry.ts";
import { ELM_LIBRARIES } from "../../engine/cql/elm/index.ts";
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

  /** `logic_version` for a measure (cached per run) — hash of its compiled ELM (+ future VSAC expansions). */
  private async logicVersion(measureId: string): Promise<string> {
    const cached = this.logicCache.get(measureId);
    if (cached) return cached;
    const meta = MEASURES[measureId];
    const elm = meta ? ELM_LIBRARIES[meta.library] : undefined;
    // Live tenants use inline urn:workwell codes (no expanded value sets) → no expansion hashes. When
    // VSAC expansion is enabled for a measure, its expansion hashes would be folded in here (future).
    const lv = await computeLogicVersion(elm ?? { unknownMeasure: measureId }, []);
    this.logicCache.set(measureId, lv);
    return lv;
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
    const temporalOk =
      row.nextTransitionAt === null || // terminal status on unchanged data
      evalDate < row.nextTransitionAt || // still before the status boundary
      row.sourceEvalDate === evalDate; // same-day reuse (covers non-boundary-safe measures)
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
