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
import { employeeById, providerById } from "../engine/synthetic/employee-catalog.ts";
import { SCALE_TENANT } from "../engine/synthetic/scale-structure.ts";
import { SCALE_TRIGGER } from "../run/backfill-scale.ts";
import { isCompletedRun } from "../program/rollup-shared.ts";

export const QUALITY_SNAPSHOT_MATERIALIZED_EVENT = "QUALITY_SNAPSHOT_MATERIALIZED";

/** Scopes whose runs represent the FULL population (so an aggregate snapshot is meaningful). SITE is a
 *  partial slice; EMPLOYEE/CASE are single-subject reruns — none materialize a population snapshot. */
const SNAPSHOT_SCOPES = new Set(["ALL_PROGRAMS", "MEASURE"]);

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

/** Resolve a live subject to its tenant → site(location) → provider scope (mirrors hierarchy-rollup keying). */
function resolveScope(subjectId: string): ScopeRef | null {
  const emp = employeeById(subjectId);
  if (!emp) return null;
  const location = providerById(emp.providerId)?.location ?? "Unknown";
  return { tenantId: emp.tenantId, site: location, providerId: emp.providerId };
}

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
  if (!SNAPSHOT_SCOPES.has(run.scopeType)) return skip(`scope ${run.scopeType} is not a population run`);
  if (!isCompletedRun(run.status)) return skip(`run not terminal (${run.status})`);

  const period = run.startedAt.slice(0, 7);
  const { start: periodStart, end: periodEnd } = monthBounds(period);
  const computedAt = new Date().toISOString();

  // Live outcomes for this run, grouped by measure. The run's own rows never include the encoded
  // scale subjects — those live only under separate `seed:scale` runs and fold in via aggregation.
  const live = await deps.outcomeStore.listOutcomes(runId);
  if (live.length === 0) return skip("run has no outcomes");
  const liveByMeasure = new Map<string, { subjectId: string; status: string }[]>();
  for (const o of live) {
    let arr = liveByMeasure.get(o.measureId);
    if (!arr) {
      arr = [];
      liveByMeasure.set(o.measureId, arr);
    }
    arr.push({ subjectId: o.subjectId, status: o.status });
  }

  // Latest COMPLETED `seed:scale` run per measure, so the population-scale tenant folds in via the
  // bounded SQL GROUP-BY (`aggregateScaleRun`) — never by materializing its 120k per-subject rows.
  const latestScaleRunByMeasure = new Map<string, { runId: string; startedAt: string }>();
  for (const r of await deps.runStore.listRuns(100_000)) {
    if (r.triggeredBy !== SCALE_TRIGGER || !isCompletedRun(r.status) || !r.scopeId) continue;
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

  await deps.qualitySnapshots.upsertSnapshots(rows);
  // Audit AFTER the upsert (not the usual audit-before-action): a snapshot is a descriptive, idempotently
  // re-materializable aggregate, not an irreversible compliance state change — re-running the run rewrites
  // it and re-audits. (The hard "audit-before" rule guards irreversible mutations; this isn't one.)
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

  return { materialized: true, rows: rows.length, period };
}
