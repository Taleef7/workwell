/**
 * Run read models (#107 strangler — runs module) — the `/api/runs` list + detail
 * shapes the unchanged frontend consumes (`RunListItem`, `RunSummary`, `RunLogEntry`).
 *
 * Computed from the floor `runs` + `outcomes` rows + the measure registry, matching
 * the Java RunPersistenceService read model exactly:
 *   - passRate = compliant * 100 / totalEvaluated   (percentage, 0 when none)
 *   - nonCompliant = DUE_SOON | OVERDUE | MISSING_DATA  (EXCLUDED is neither)
 *   - dataFreshAsOf = MAX(evaluated_at); dataFreshnessMinutes = -1 when no outcomes
 *   - measureName/Version resolved from scopeId (null → "All Programs" / "")
 *
 * Note: `totalCases` is 0 until the cases module is ported (later #107 slice), and
 * `triggerType` is "MANUAL" — the floor only holds manually-created runs so far.
 */
import type { RunRecord, RunLogRow } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

export interface RunListItem {
  runId: string;
  measureName: string;
  status: string;
  scopeType: string;
  triggerType: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  totalEvaluated: number;
  compliantCount: number;
  nonCompliantCount: number;
}

export interface RunSummary extends RunListItem {
  measureVersion: string;
  totalCases: number;
  passRate: number;
  outcomeCounts: Array<{ status: string; count: number }>;
  dataFreshAsOf: string | null;
  dataFreshnessMinutes: number;
}

export interface RunLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

const NON_COMPLIANT = new Set(["DUE_SOON", "OVERDUE", "MISSING_DATA"]);

function measureLabel(scopeId: string | null): { name: string; version: string } {
  const m = scopeId ? MEASURES[scopeId] : undefined;
  if (!m) return { name: "All Programs", version: "" };
  const dash = m.library.lastIndexOf("-");
  return { name: m.name, version: dash >= 0 ? m.library.slice(dash + 1) : "" };
}

function tally(outcomes: OutcomeRecord[]) {
  let compliant = 0;
  let nonCompliant = 0;
  const byStatus = new Map<string, number>();
  let freshAsOf: string | null = null;
  for (const o of outcomes) {
    byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
    if (o.status === "COMPLIANT") compliant++;
    else if (NON_COMPLIANT.has(o.status)) nonCompliant++;
    if (freshAsOf === null || o.evaluatedAt > freshAsOf) freshAsOf = o.evaluatedAt;
  }
  return { total: outcomes.length, compliant, nonCompliant, byStatus, freshAsOf };
}

function durationMs(run: RunRecord): number {
  if (!run.completedAt) return 0;
  return Math.max(0, new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime());
}

export function toRunListItem(run: RunRecord, outcomes: OutcomeRecord[]): RunListItem {
  const t = tally(outcomes);
  return {
    runId: run.id,
    measureName: measureLabel(run.scopeId).name,
    status: run.status,
    scopeType: run.scopeType,
    triggerType: "MANUAL",
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: durationMs(run),
    totalEvaluated: t.total,
    compliantCount: t.compliant,
    nonCompliantCount: t.nonCompliant,
  };
}

export function toRunSummary(run: RunRecord, outcomes: OutcomeRecord[]): RunSummary {
  const { name, version } = measureLabel(run.scopeId);
  const t = tally(outcomes);
  return {
    ...toRunListItem(run, outcomes),
    measureName: name,
    measureVersion: version,
    totalCases: 0,
    passRate: t.total === 0 ? 0 : (t.compliant * 100) / t.total,
    outcomeCounts: [...t.byStatus.entries()].map(([status, count]) => ({ status, count })),
    dataFreshAsOf: t.freshAsOf,
    dataFreshnessMinutes: t.freshAsOf === null ? -1 : Math.floor((Date.now() - new Date(t.freshAsOf).getTime()) / 60000),
  };
}

export function toRunLogEntries(logs: RunLogRow[]): RunLogEntry[] {
  return logs.map((l) => ({ timestamp: l.ts, level: l.level, message: l.message }));
}
