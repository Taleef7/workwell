/**
 * E16 PR-2 — quality-over-time BACKFILL. Materializes `quality_snapshots` for a range of past calendar
 * months, so the /programs trend has real numerator/denominator history instead of the synthetic
 * sine-wave `backfill-trend-history` rates it supersedes. This is Doug's "dump into a table and get the
 * numerators and denominators" for December/October/August.
 *
 * For each month it re-evaluates every in-directory (live) employee as-of that month's end — genuinely
 * evaluated, not faked — reusing the exact synthetic-bundle anchoring the per-employee Simulate #197 uses
 * (bundle anchored to `today`, evaluated as-of the past date, so RECURRING measures age realistically
 * toward today), reduces the raw CQL outcomes through the shared pure `buildSnapshotRows` core, and
 * idempotently upserts. The 120k `mhn` scale tenant folds in via the bounded `aggregateScaleRun` (never
 * its per-subject rows) — but note the scale population is GENERATED demo data with no time dimension, so
 * its current distribution is folded UNCHANGED into every historical month (there is no per-month history
 * to recover for it). Only the live `twh`/`ihn` tenants vary month-to-month; at population scale the
 * `all` aggregate is ~99.9% scale, so the `all` trend is dominated by that time-invariant distribution
 * (per-tenant scopes show the real evaluated variation). Descriptive only — CQL `Outcome Status` is the
 * sole authority (ADR-008/ADR-021).
 *
 * Owner-run, on-demand, NOT wired into request-path startup. Idempotent + resumable at the month level.
 * REVERSIBLE — the whole table is a rebuildable cache: `DELETE FROM workwell_spike.quality_snapshots;`
 * (schema-qualify on the Pg ceiling). See DATA_MODEL §3.24.
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { QualitySnapshotInput, QualitySnapshotStore } from "../stores/quality-snapshot-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { buildSnapshotRows, type ScaleGroup, type ScopeRef } from "../quality/materialize-snapshot.ts";
import { EMPLOYEES, employeeById, providerById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { SCALE_TENANT } from "../engine/synthetic/scale-structure.ts";
import { SCALE_TRIGGER } from "./backfill-scale.ts";
import { isCompletedRun } from "../program/rollup-shared.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededTargetFor } from "./distribution.ts";
import type { SnapshotEngine } from "./employee-compliance-snapshot.ts";

export const QUALITY_HISTORY_BACKFILLED_EVENT = "QUALITY_HISTORY_BACKFILLED";

export interface QualityBackfillDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  qualitySnapshots: QualitySnapshotStore;
  auditStore: Pick<CaseEventStore, "appendAudit">;
  engine: SnapshotEngine;
  /** Override the directory (tests); defaults to the full synthetic workforce. */
  employees?: readonly EmployeeProfile[];
  /** Anchor date for synthetic bundles (YYYY-MM-DD); defaults to today. */
  today?: string;
}

export interface QualityBackfillArgs {
  /** Number of trailing calendar months to backfill (inclusive of `asOf`'s month). Default 12. */
  months?: number;
  /** Newest month `YYYY-MM` to backfill (inclusive). Default: the current month. */
  asOf?: string;
  /** Skip a month that already has snapshot rows (resumability). Default true. */
  resume?: boolean;
}

export interface QualityBackfillSummary {
  months: number;
  monthsWritten: number;
  monthsSkipped: number;
  rowsWritten: number;
}

/** Resolve a live subject to its tenant → site(location) → provider scope (mirrors materialize-run). */
function resolveScope(subjectId: string): ScopeRef | null {
  const emp = employeeById(subjectId);
  if (!emp) return null;
  const location = providerById(emp.providerId)?.location ?? "Unknown";
  return { tenantId: emp.tenantId, site: location, providerId: emp.providerId };
}

/** The trailing month list ending at `asOf` (inclusive), oldest first. */
function monthRange(asOf: string, months: number): string[] {
  const [y, m] = asOf.split("-").map(Number);
  const out: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y!, m! - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** ISO bounds + the as-of (last-day) evaluation date of the calendar month `YYYY-MM`. */
function monthBounds(period: string): { start: string; end: string; asOfDate: string } {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const endExclusive = new Date(Date.UTC(y!, m!, 1));
  const end = new Date(endExclusive.getTime() - 1);
  return { start: start.toISOString(), end: end.toISOString(), asOfDate: end.toISOString().slice(0, 10) };
}

export async function backfillQualityHistory(
  deps: QualityBackfillDeps,
  args: QualityBackfillArgs = {},
): Promise<QualityBackfillSummary> {
  const months = args.months ?? 12;
  const now = new Date();
  const asOf = args.asOf ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const resume = args.resume ?? true;
  const today = deps.today ?? now.toISOString().slice(0, 10);
  const employees = deps.employees ?? EMPLOYEES;
  const computedAt = new Date().toISOString();

  // Latest COMPLETED seed:scale run per measure → the bounded mhn fold (same as materialize-run).
  // Compare `startedAt` explicitly (mirrors materialize-run.ts) rather than relying on listRuns'
  // DESC ordering — robust if the ordering contract ever changes or duplicate scale runs exist.
  const latestScaleRunByMeasure = new Map<string, { runId: string; startedAt: string }>();
  // Fable M16: query only the seed:scale runs by triggered_by instead of scanning the whole runs table.
  for (const r of await deps.runStore.listRunsByTriggeredBy(SCALE_TRIGGER)) {
    if (!isCompletedRun(r.status) || !r.scopeId) continue;
    const prev = latestScaleRunByMeasure.get(r.scopeId);
    if (!prev || r.startedAt > prev.startedAt) latestScaleRunByMeasure.set(r.scopeId, { runId: r.id, startedAt: r.startedAt });
  }
  const scaleGroupsByMeasure = new Map<string, ScaleGroup[]>();
  for (const [measureId, run] of latestScaleRunByMeasure) {
    const groups = await deps.outcomeStore.aggregateScaleRun(run.runId);
    if (groups.length > 0) scaleGroupsByMeasure.set(measureId, groups);
  }

  const measureIds = Object.keys(MEASURES).filter((id) => MEASURE_BINDINGS[id]);
  const periods = monthRange(asOf, months);
  let monthsWritten = 0;
  let monthsSkipped = 0;
  let rowsWritten = 0;

  for (const period of periods) {
    if (resume) {
      // Skip only a COMPLETE month — one that already has an `all`-scope row for every expected
      // measure. Skipping on "any row exists" would abandon a month that PR-1 materialized for a
      // single measure, or a backfill interrupted mid-write, leaving measures/scopes missing from
      // /api/quality/history. An incomplete month is recomputed (the idempotent upsert fills the
      // gaps + overwrites in place, last-write-wins).
      const existing = await deps.qualitySnapshots.querySnapshots({ from: period, to: period });
      const coveredMeasures = new Set(existing.filter((r) => r.scopeLevel === "all").map((r) => r.measureId));
      if (measureIds.every((id) => coveredMeasures.has(id))) {
        monthsSkipped++;
        continue;
      }
    }
    const { start: periodStart, end: periodEnd, asOfDate } = monthBounds(period);
    const rows: QualitySnapshotInput[] = [];

    for (const measureId of measureIds) {
      const binding = MEASURE_BINDINGS[measureId]!;
      const liveOutcomes: { subjectId: string; status: string }[] = [];
      for (const employee of employees) {
        try {
          const target = seededTargetFor(employees, binding.rateKey, employee.externalId) ?? "MISSING_DATA";
          const config = deriveExamConfig(binding, target);
          const bundle = buildSyntheticBundle(employee, config, today); // anchor to today
          const outcome = await deps.engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: asOfDate });
          liveOutcomes.push({ subjectId: employee.externalId, status: outcome.outcome });
        } catch {
          liveOutcomes.push({ subjectId: employee.externalId, status: "MISSING_DATA" });
        }
      }
      const groups = scaleGroupsByMeasure.get(measureId);
      const scale = groups ? { tenantId: SCALE_TENANT.id, groups } : undefined;
      rows.push(
        ...buildSnapshotRows({ measureId, period, periodStart, periodEnd, sourceRunId: null, computedAt, liveOutcomes, resolveScope, scale }),
      );
    }

    // Audit BEFORE the state change (hard rule), mirroring materialize-run.
    await deps.auditStore.appendAudit({
      eventType: QUALITY_HISTORY_BACKFILLED_EVENT,
      entityType: "quality_snapshot",
      entityId: null,
      actor: "seed:quality-history",
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { period, measureCount: measureIds.length, rowCount: rows.length },
    });
    await deps.qualitySnapshots.upsertSnapshots(rows);
    monthsWritten++;
    rowsWritten += rows.length;
  }

  return { months: periods.length, monthsWritten, monthsSkipped, rowsWritten };
}
