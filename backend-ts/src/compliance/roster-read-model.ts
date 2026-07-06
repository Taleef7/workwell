/**
 * Roster read model (E10.2) — `GET /api/compliance/roster`. Rows = every directory subject, columns =
 * the selected panel's Active measures, each cell = the E10.5 display state + method derived from the
 * subject's outcome in that measure's LATEST population run (NA when there is none). Read-time; no schema.
 * Reuses the "latest population run per measure" path the hierarchy rollup uses (`listOutcomesWithRun` +
 * `latestRunRows`) and loads evidence per run via `listOutcomes` (cached by run id).
 */
import type { OutcomeStore, OutcomeWithRun, OutcomeRecord } from "../stores/outcome-store.ts";
import { EMPLOYEES, employeeById, tenantById, isDemoPersona } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { isCompletedRun, isPopulationRun, latestRunRows } from "../program/rollup-shared.ts";
import { isApplicable, matchesCohort } from "../segment/segment-applicability.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { PANELS, DEFAULT_PANEL, isPanelId, type PanelId } from "./panels.ts";
import { deriveCell, type Cell } from "./roster-vocabulary.ts";

export interface RosterColumn {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
}
export interface RosterCell extends Cell {
  evidenceRef?: { runId: string; outcomeId: string };
}
export interface RosterRow {
  subject: { externalId: string; name: string; role: string; site: string; tenantId: string; tenantName: string };
  cells: Record<string, RosterCell>;
}
export interface Roster {
  panel: PanelId;
  columns: RosterColumn[];
  rows: RosterRow[];
  total: number;
}

/**
 * Per-measure cache of a run's derived cells (perf #233 follow-up). A COMPLETED population run's
 * outcomes are immutable and `deriveCell`/`deriveWhyFlagged` are pure over them (no "today"
 * dependence — the recency/overdue numbers come from the CQL defines baked into evidence at
 * evaluation time), so the derived cell map for a measure's latest run is stable. Keyed by
 * `measureId` and superseded when a newer run appears (a Recalculate mints a new runId), so it holds
 * one entry per measure — the repeat roster load then skips the ~1.3MB `evidence_json` fetch +
 * derive entirely.
 */
export type RosterCellCache = Map<string, { runId: string; cells: Map<string, RosterCell> }>;

/**
 * Process-lifetime roster cell cache (the route passes this shared instance; the worker is a
 * long-lived singleton, so it persists across requests). Tests that omit `cellCache` derive fresh
 * each call, preserving isolation.
 */
export const rosterCellCache: RosterCellCache = new Map();

export interface RosterDeps {
  outcomeStore: OutcomeStore;
  /** Configured risk-group segments (E11.3). Drives the N/A applicability overlay + `segment` filter. */
  segments?: HydratedSegment[];
  /** Optional persistent derived-cell cache (perf #233). Omit in tests for per-call isolation. */
  cellCache?: RosterCellCache;
}
export interface RosterFilters {
  panel?: string | null;
  status?: string | null;
  site?: string | null;
  role?: string | null;
  q?: string | null;
  /** Scope rows to a segment's cohort + columns to its rule-set (E11.3). */
  segment?: string | null;
  /** Scope rows to one tenant/system (E13 PR-1). */
  tenant?: string | null;
  page?: number;
  pageSize?: number;
}

export async function buildRoster(deps: RosterDeps, filters: RosterFilters): Promise<Roster> {
  const panel: PanelId = filters.panel && isPanelId(filters.panel) ? filters.panel : DEFAULT_PANEL;
  const active = new Set(MEASURE_CATALOG.filter((m) => m.status === "Active").map((m) => m.id));

  // E11.3 segments: an active `segment` filter scopes columns to that segment's rule-set (∩ Active);
  // otherwise columns are the panel set. `segments` (the configured set) drives the N/A overlay below.
  const segments = deps.segments ?? [];
  // Only an ENABLED segment can scope the grid — a disabled segment is not in effect, so filtering by
  // one falls back to the panel view (otherwise its columns would all read NOT_APPLICABLE, since the
  // overlay below only counts enabled segments). Keeps the filter consistent with applicability.
  const activeSegment = filters.segment ? segments.find((s) => s.id === filters.segment && s.enabled) ?? null : null;
  const measureIds = activeSegment
    ? activeSegment.measureIds.filter((m) => active.has(m))
    : PANELS[panel].filter((m) => active.has(m));
  const columns: RosterColumn[] = measureIds.map((id) => ({
    measureId: id,
    name: MEASURES[id]?.name ?? id,
    complianceClass: MEASURE_BINDINGS[id]?.complianceClass ?? "RECURRING",
  }));

  // 1) latest population run per panel measure (no evidence) → its run id. Exclude single-subject
  //    CASE/EMPLOYEE reruns AND in-flight RUNNING runs — an async ALL_PROGRAMS/SITE run persists each
  //    outcome before it finalizes, so without the terminal-status guard `latestRunRows` could pick a
  //    partial in-flight run and surface partial statuses/NA (matches programOverview / order proposals).
  // excludeScale: the population-scale tenant (~120k rows) is excluded IN SQL — the roster is the
  // live directory grid (E13 PR-2 scope excludes scale), and a seed:scale run must never become a
  // measure's "latest population run" here (it would both load 120k rows and show NA for everyone).
  // excludeTrendHistory (Fable M16): the backdated synthetic trend rows are always older than each
  // measure's latest real run (the seeding invariant), so `latestRunRows` never picks them — dropping
  // them in SQL just avoids fetching-then-discarding a growing block of rows.
  // perf #233 residual: reduce to the latest terminal population run per measure IN SQL rather than
  // fetching every population run's rows across all history and reducing in JS. The returned set is
  // exactly `listOutcomesWithRun(...).filter(pop && completed)` → group-by-measure → `latestRunRows`
  // (store-contract asserts the equivalence), so the downstream grouping + `latestRunRows` below stay
  // unchanged (now a passthrough — one run per measure) and the output is byte-identical.
  const popRows = (await deps.outcomeStore.listLatestPopulationOutcomes({ excludeScale: true, excludeTrendHistory: true })).filter(
    (r) => isPopulationRun(r.runScopeType) && isCompletedRun(r.runStatus), // redundant guard: the store already applies both (defense-in-depth)
  );
  const byMeasure = new Map<string, OutcomeWithRun[]>();
  for (const r of popRows) {
    if (!measureIds.includes(r.measureId)) continue;
    (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
  }

  // 2) per measure: load that run's outcomes WITH evidence (cached by run id) → cell per subject.
  const runCache = new Map<string, OutcomeRecord[]>();
  const loadRun = async (runId: string): Promise<OutcomeRecord[]> => {
    const cached = runCache.get(runId);
    if (cached) return cached;
    const rows = await deps.outcomeStore.listOutcomes(runId);
    runCache.set(runId, rows);
    return rows;
  };
  const cellByMeasureSubject = new Map<string, Map<string, RosterCell>>();
  for (const m of measureIds) {
    const latest = latestRunRows(byMeasure.get(m) ?? []);
    if (latest.length === 0) {
      cellByMeasureSubject.set(m, new Map());
      continue;
    }
    const runId = latest[0]!.runId;
    // Reuse the derived cells for this measure's latest (immutable) run — skips the ~1.3MB evidence
    // load + derive on repeat requests. The cached cells are read-only downstream (assembled by
    // reference into rows, never mutated), so sharing the map across requests is safe.
    const cached = deps.cellCache?.get(m);
    if (cached && cached.runId === runId) {
      cellByMeasureSubject.set(m, cached.cells);
      continue;
    }
    const cells = new Map<string, RosterCell>();
    for (const o of await loadRun(runId)) {
      if (o.measureId !== m) continue;
      // Freeze the cell: cached cells are shared BY REFERENCE across requests (and assembled by
      // reference into each response's rows), so any accidental post-build mutation would silently
      // corrupt another request's view. Freezing makes that a loud throw instead — enforcing the
      // read-only invariant this cache relies on.
      cells.set(o.subjectId, Object.freeze({ ...deriveCell(o.status, o.evidence, m, o.evaluationPeriod), evidenceRef: { runId, outcomeId: o.id } }));
    }
    deps.cellCache?.set(m, { runId, cells }); // supersedes any older run's entry for this measure (bounded to #measures)
    cellByMeasureSubject.set(m, cells);
  }

  // 3) assemble rows over the whole directory; NA where a measure has no cell for the subject.
  //    Then apply the E11.3 applicability overlay: a measure the subject is in NO enabled segment for
  //    becomes NOT_APPLICABLE (out-of-cohort wins over any real outcome; no evidenceRef). With zero
  //    enabled segments `isApplicable` is always true ⇒ no overlay (today's behavior).
  let rows: RosterRow[] = EMPLOYEES.map((emp) => {
    const cells: Record<string, RosterCell> = {};
    for (const m of measureIds) {
      if (!isApplicable(emp, m, segments)) {
        cells[m] = { status: "NOT_APPLICABLE", method: "Not applicable (no matching group)" };
        continue;
      }
      cells[m] = cellByMeasureSubject.get(m)?.get(emp.externalId) ?? { status: "NA", method: "Not evaluated" };
    }
    return {
      subject: {
        externalId: emp.externalId, name: emp.name, role: emp.role, site: emp.site,
        tenantId: emp.tenantId, tenantName: tenantById(emp.tenantId)?.name ?? emp.tenantId,
      },
      cells,
    };
  });

  // 3b) segment filter: scope rows to the active segment's cohort (before site/role/search/status + paging).
  if (activeSegment) {
    rows = rows.filter((r) => {
      const e = employeeById(r.subject.externalId);
      return e ? matchesCohort(e, activeSegment) : false;
    });
  }

  // 4) filters (tenant/site/role/search/status), then page.
  if (filters.tenant) rows = rows.filter((r) => r.subject.tenantId === filters.tenant);
  if (filters.site) rows = rows.filter((r) => r.subject.site === filters.site);
  if (filters.role) rows = rows.filter((r) => r.subject.role === filters.role);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    rows = rows.filter((r) => r.subject.name.toLowerCase().includes(q) || r.subject.externalId.toLowerCase().includes(q));
  }
  if (filters.status) {
    const s = filters.status.toUpperCase();
    rows = rows.filter((r) => Object.values(r.cells).some((c) => c.status === s));
  }

  // Roster ordering (UX-1): the four demo-login personas (emp-001..004 — system roles, no occupational
  // measures) sink to the BOTTOM by an EXPLICIT demo-persona marker, not a has-data heuristic — an
  // `All Employees` segment can give a persona one Compliant cell, which a has-data check would treat as
  // "real data" and float four fake users to the top of the flagship roster. Secondary: real employees
  // with evaluated data still sort above real all-NA rows. Stable: a paired-index tiebreaker preserves
  // directory order within each group.
  const isDemo = (r: RosterRow) => isDemoPersona(r.subject.externalId);
  const hasData = (r: RosterRow) => Object.values(r.cells).some((c) => c.status !== "NA" && c.status !== "NOT_APPLICABLE");
  rows = rows
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        Number(isDemo(a.r)) - Number(isDemo(b.r)) || // demo personas last
        Number(hasData(b.r)) - Number(hasData(a.r)) || // then real-data before all-NA
        a.i - b.i,
    )
    .map((x) => x.r);

  const total = rows.length;
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(filters.pageSize ?? 50), 200));
  const start = (page - 1) * pageSize;
  return { panel, columns, rows: rows.slice(start, start + pageSize), total };
}
