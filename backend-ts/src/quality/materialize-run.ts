/**
 * E16 — materializeRun orchestration. On completion of a population run (ALL_PROGRAMS/MEASURE), reduce
 * its live outcomes (+ the latest scale run per measure, folded via the bounded `aggregateScaleRun`)
 * into per-(measure, calendar month, scope) `quality_snapshots`, persist them idempotently (last write
 * wins on the month/scope), and write one `QUALITY_SNAPSHOT_MATERIALIZED` audit event.
 *
 * Wires the real synthetic directory (employee → tenant/site/provider) into the pure `buildSnapshotRows`
 * core. NEVER lists the per-subject rows of a `seed:scale` run (those are O(120k)); the scale tenant
 * folds in via the SQL GROUP-BY aggregation only. The caller invokes this best-effort — a snapshot
 * failure must never fail the run. Descriptive only: counts what CQL already decided (ADR-008).
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { QualitySnapshotInput, QualitySnapshotStore } from "../stores/quality-snapshot-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { buildSnapshotRows, type ScaleGroup, type ScopeRef } from "./materialize-snapshot.ts";
import { directoryForRows } from "../engine/ingress/webchart/live-directory.ts";
import { DIRECTORY } from "../config/deployment-profile.ts";
import { SCALE_TENANT } from "../engine/synthetic/scale-structure.ts";
import { SCALE_TRIGGER } from "../run/backfill-scale.ts";
import { isCompletedRun, isPopulationRun } from "../program/rollup-shared.ts";

export const QUALITY_SNAPSHOT_MATERIALIZED_EVENT = "QUALITY_SNAPSHOT_MATERIALIZED";

// Scopes whose runs represent the FULL population (so an aggregate snapshot is meaningful) are the same
// allowlist the roster and the programs overview use (`POPULATION_SCOPES`, ADR-077 d4): SITE is a
// partial slice; EMPLOYEE/CASE are single-subject reruns — none materialize a population snapshot.

export interface MaterializeDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  qualitySnapshots: QualitySnapshotStore;
  events: Pick<CaseEventStore, "appendAudit">;
}

export interface MaterializeResult {
  materialized: boolean;
  rows: number;
  period: string | null;
  reason?: string;
}

const skip = (reason: string): MaterializeResult => ({ materialized: false, rows: 0, period: null, reason });

/** ISO bounds of the calendar month `YYYY-MM`. */
function monthBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const end = new Date(Date.UTC(y!, m!, 1) - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function materializeRun(runId: string, deps: MaterializeDeps): Promise<MaterializeResult> {
  const run = await deps.runStore.getRun(runId);
  if (!run) return skip("run not found");
  if (run.triggeredBy === SCALE_TRIGGER) return skip("scale seed run (never listed per-subject)");
  if (!isPopulationRun(run.scopeType)) return skip(`scope ${run.scopeType} is not a population run`);
  if (!isCompletedRun(run.status)) return skip(`run not terminal (${run.status})`);

  const period = run.startedAt.slice(0, 7);
  const { start: periodStart, end: periodEnd } = monthBounds(period);
  const computedAt = new Date().toISOString();

  // Live outcomes for this run, grouped by measure. The run's own rows never include the encoded
  // scale subjects — those live only under separate `seed:scale` runs and fold in via aggregation.
  const live = await deps.outcomeStore.listOutcomes(runId);
  if (live.length === 0) return skip("run has no outcomes");
  const directory = directoryForRows(live, true, undefined, DIRECTORY);
  /** Resolve through this run's one merged directory snapshot, including restart-rehydrated wc rows. */
  const resolveScope = (subjectId: string): ScopeRef | null => {
    const emp = directory.employeeById(subjectId);
    if (!emp) return null;
    const location = directory.providerById(emp.providerId)?.location ?? "Unknown";
    return { tenantId: emp.tenantId, site: location, providerId: emp.providerId };
  };
  const liveByMeasure = new Map<string, { subjectId: string; status: string; outOfPopulation?: boolean }[]>();
  for (const o of live) {
    let arr = liveByMeasure.get(o.measureId);
    if (!arr) {
      arr = [];
      liveByMeasure.set(o.measureId, arr);
    }
    arr.push({ subjectId: o.subjectId, status: o.status, outOfPopulation: o.outOfPopulation === true });
  }

  // Latest COMPLETED `seed:scale` run per measure, so the population-scale tenant folds in via the
  // bounded SQL GROUP-BY (`aggregateScaleRun`) — never by materializing its 120k per-subject rows.
  const latestScaleRunByMeasure = new Map<string, { runId: string; startedAt: string }>();
  // Fable M16: query only the ~14 seed:scale runs by triggered_by instead of scanning the whole runs
  // table (listRuns(100_000)) on every run completion.
  for (const r of await deps.runStore.listRunsByTriggeredBy(SCALE_TRIGGER)) {
    if (!isCompletedRun(r.status) || !r.scopeId) continue;
    const prev = latestScaleRunByMeasure.get(r.scopeId);
    if (!prev || r.startedAt > prev.startedAt) latestScaleRunByMeasure.set(r.scopeId, { runId: r.id, startedAt: r.startedAt });
  }

  const rows: QualitySnapshotInput[] = [];
  for (const [measureId, liveOutcomes] of liveByMeasure) {
    let scale: { tenantId: string; groups: ScaleGroup[] } | undefined;
    const scaleRun = latestScaleRunByMeasure.get(measureId);
    if (scaleRun) {
      const groups = await deps.outcomeStore.aggregateScaleRun(scaleRun.runId);
      if (groups.length > 0) scale = { tenantId: SCALE_TENANT.id, groups };
    }
    rows.push(
      ...buildSnapshotRows({ measureId, period, periodStart, periodEnd, sourceRunId: runId, computedAt, liveOutcomes, resolveScope, scale }),
    );
  }

  // Audit BEFORE the state change (hard rule: every state change writes an audit_event — no exceptions),
  // mirroring the scheduler's audit-before-create. Writing the audit after the upsert could, on a
  // transient `appendAudit` failure, leave persisted snapshot rows without their ledger entry. If the
  // upsert then fails, the best-effort caller (`finishManualRun`) logs it and the next population run
  // re-materializes idempotently (last-write-wins on the month/scope).
  await deps.events.appendAudit({
    eventType: QUALITY_SNAPSHOT_MATERIALIZED_EVENT,
    entityType: "run",
    entityId: runId,
    actor: run.triggeredBy || "system",
    refRunId: runId,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: { period, measureCount: liveByMeasure.size, rowCount: rows.length },
  });
  await deps.qualitySnapshots.upsertSnapshots(rows);

  return { materialized: true, rows: rows.length, period };
}

export interface RebuildResult {
  /** Months re-materialized from their newest completed population run, oldest first. */
  rebuilt: { period: string; runId: string; rows: number }[];
  /** Months with a run that could not be re-materialized (e.g. its outcomes were compacted). */
  skipped: { period: string; runId: string; reason: string }[];
}

/**
 * #676 — put the stored history on the population basis. Re-materializes every month from its NEWEST
 * completed population run, which is the run whose rows the nightly left in place (each run
 * re-materializes its month, last write wins), so a rebuilt month is what the nightly would have
 * written had it left out-of-population subjects out at the time. It reads the run's PERSISTED
 * outcomes and their persisted flag; nothing is re-evaluated. Each month writes its own
 * `QUALITY_SNAPSHOT_MATERIALIZED` audit event through `materializeRun`.
 *
 * A month with snapshot rows but no surviving run (retention, or a synthetic backfill) keeps its old
 * rows, which the screens keep refusing where they would understate the rate. Owner-run, one-shot,
 * idempotent: `pnpm rebuild:quality-snapshots`.
 */
export async function rebuildSnapshotHistory(deps: MaterializeDeps): Promise<RebuildResult> {
  const newestByMonth = new Map<string, string>();
  // Newest-first, so the first run seen for a month is its newest.
  for (const run of await deps.runStore.listRuns(100_000)) {
    if (run.triggeredBy === SCALE_TRIGGER || !isPopulationRun(run.scopeType) || !isCompletedRun(run.status)) continue;
    const period = run.startedAt.slice(0, 7);
    if (!newestByMonth.has(period)) newestByMonth.set(period, run.id);
  }
  const result: RebuildResult = { rebuilt: [], skipped: [] };
  for (const [period, runId] of [...newestByMonth].sort(([a], [b]) => a.localeCompare(b))) {
    const r = await materializeRun(runId, deps);
    if (r.materialized) result.rebuilt.push({ period, runId, rows: r.rows });
    else result.skipped.push({ period, runId, reason: r.reason ?? "not materialized" });
  }
  return result;
}
