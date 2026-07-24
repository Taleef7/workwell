/**
 * Storage contract — `EvalStateStore` (#263 Phase 2b). The incremental-evaluation cache: one row per
 * (subject, measure, period) recording the change-signal fingerprint of the last REAL CQL evaluation,
 * so a later run can decide whether re-evaluating that subject can possibly change the answer, and if
 * not, copy the prior outcome forward instead of spending ~68 ms of CQL on it.
 *
 * A pure CACHE — every row is derivable by a full run, and dropping the table just makes the next run a
 * full run (DATA_MODEL §3.27). It never sets or overrides `Outcome Status` (ADR-008): it decides only
 * WHETHER to re-ask the engine.
 */

export interface EvalStateRow {
  id: string;
  subjectId: string;
  measureId: string;
  period: string;
  /** sha256:<hex> of the canonicalized evaluated bundle at the last real evaluation. */
  dataHash: string;
  /** sha256:<hex> of (measure ELM + referenced value-set expansion hashes) at the last real evaluation. */
  logicVersion: string;
  /**
   * Earliest date (`YYYY-MM-DD`) the status can change on unchanged data. `null` ⇒ terminal (reuse
   * until data/logic changes). A date > the source eval date ⇒ reuse while `evalDate < next_transition_at`.
   * A date == the source eval date ⇒ no across-day reuse (only a same-day hit; see `next-transition.ts`).
   */
  nextTransitionAt: string | null;
  /** The CQL `Outcome Status` the source evaluation produced — copied forward on a cache hit. */
  lastStatus: string;
  /** The `outcomes.id` of the source (real) evaluation whose evidence is copied forward. */
  sourceOutcomeId: string;
  /** The run evaluation date (`YYYY-MM-DD`) of the source evaluation — the anchor for evidence recompute. */
  sourceEvalDate: string;
  /** Wall-clock ISO timestamp of the last real evaluation (audit/debugging only). */
  lastEvaluatedAt: string;
}

export type UpsertEvalStateInput = Omit<EvalStateRow, "id">;

export interface EvalStateStore {
  /** The one row for a (subject, measure, period), or null. */
  getEvalState(subjectId: string, measureId: string, period: string): Promise<EvalStateRow | null>;
  /**
   * All rows for a (measure, period) — the bulk read a run loads once per measure and indexes by
   * subject, so the reuse check costs O(measures) DB round trips, not O(subjects).
   */
  listEvalStatesForMeasurePeriod(measureId: string, period: string): Promise<EvalStateRow[]>;
  /** Upsert on the (subject, measure, period) key — last write wins (INSERT OR REPLACE / ON CONFLICT). */
  upsertEvalState(input: UpsertEvalStateInput): Promise<void>;
}
