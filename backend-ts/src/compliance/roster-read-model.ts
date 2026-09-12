/**
 * Roster read model (E10.2) — `GET /api/compliance/roster`. Rows = every directory subject, columns =
 * the selected panel's Active measures, each cell = the E10.5 display state + method derived from the
 * subject's outcome in that measure's LATEST population run (NA when there is none). Read-time; no schema.
 * The winning run per column comes from `listLatestPopulationRuns` (the runs table — no outcome row is
 * read to learn it), and each column's cells from `listOutcomes(runId, { measureId })`, derived once per
 * (measure, run) into the process-lifetime cell cache.
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { isDemoPersona } from "../engine/synthetic/employee-catalog.ts";
import { directoryForRows } from "../engine/ingress/webchart/live-directory.ts";
import { DIRECTORY, isRunnableMeasure } from "../config/deployment-profile.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { payerNameOf } from "../engine/synthetic/payer-display.ts";
import { isCompletedRun, isPopulationRun } from "../program/rollup-shared.ts";
import { isApplicable, matchesCohort } from "../segment/segment-applicability.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { isPanelId, ACTIVE_CATALOG_MEASURE_IDS, AVAILABLE_PANELS, PROFILE_DEFAULT_PANEL, RUNNABLE_PANELS, type PanelId } from "./panels.ts";
import { deriveCell, type Cell } from "./roster-vocabulary.ts";
import { hasActiveSubjectFilters, matchesSubjectFilters, type SubjectFilters } from "./subject-filters.ts";

export interface RosterColumn {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
}
export interface RosterCell extends Cell {
  evidenceRef?: { runId: string; outcomeId: string };
}
export interface RosterRow {
  subject: {
    externalId: string; name: string; role: string; site: string; tenantId: string; tenantName: string;
    /**
     * The panel facts (MM-2): attributed PCP and primary payer. Ids are what the filters match on,
     * names are display; both travel together so a cell can be labelled without a second lookup.
     * Null where the directory records none — the occupational roster has no payer, and a live
     * WebChart directory has neither until Coverage extraction lands (#533).
     */
    providerId: string | null; providerName: string | null; payer: string | null; payerName: string | null;
  };
  cells: Record<string, RosterCell>;
}
export interface Roster {
  panel: PanelId;
  availablePanels: PanelId[];
  columns: RosterColumn[];
  rows: RosterRow[];
  total: number;
  /**
   * Rows withheld because the measure in scope does not describe them (ADR-078/079). Non-zero only
   * on a SINGLE-measure roster, where such a patient is not work; `total` already excludes them.
   * Returned so the surface can say how many rather than serve a shorter list with no account of it.
   */
  notInPopulation: number;
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
  /** Runtime environment consumed only through the existing isWebChartConfigured predicate. */
  webChartEnv?: DataSourceEnv;
  /** Configured risk-group segments (E11.3). Drives the N/A applicability overlay + `segment` filter. */
  segments?: HydratedSegment[];
  /** Optional persistent derived-cell cache (perf #233). Omit in tests for per-call isolation. */
  cellCache?: RosterCellCache;
}
/**
 * The roster's filters. **Extends `SubjectFilters` rather than restating it** — the panel filters used
 * to be re-declared here as three fields and re-assembled field-by-field at the call site, so adding
 * `payer` to the shared predicate left the roster silently passing `{providerId, ageBand, sex}` and
 * dropping it: the guard said a filter was active, the predicate found none, and every row passed. An
 * unfiltered 20,000-patient roster came back under a heading that said Medicare. Inheriting the type
 * means the next filter added to `SubjectFilters` is on this surface the moment it exists.
 */
export interface RosterFilters extends SubjectFilters {
  panel?: string | null;
  status?: string | null;
  /** Drill-down scope (E12): restrict the status filter to one measure's column. */
  measureId?: string | null;
  site?: string | null;
  role?: string | null;
  q?: string | null;
  /** Scope rows to a segment's cohort + columns to its rule-set (E11.3). */
  segment?: string | null;
  /** Scope rows to one tenant/system (E13 PR-1). */
  tenant?: string | null;
  // The panel filters (PCP, age band, sex, payer) come from `SubjectFilters` above. They are applied at
  // the same layer `site` is, as a read-time join against the directory — the store never sees them.
  page?: number;
  pageSize?: number;
}

export async function buildRoster(deps: RosterDeps, filters: RosterFilters): Promise<Roster> {
  const requestedPanel: PanelId = filters.panel && isPanelId(filters.panel) ? filters.panel : PROFILE_DEFAULT_PANEL;
  const panel: PanelId = AVAILABLE_PANELS.includes(requestedPanel) ? requestedPanel : PROFILE_DEFAULT_PANEL;
  // E11.3 segments: an active `segment` filter scopes columns to that segment's rule-set (∩ Active);
  // otherwise columns are the panel set. `segments` (the configured set) drives the N/A overlay below.
  const segments = deps.segments ?? [];
  // Only an ENABLED segment can scope the grid — a disabled segment is not in effect, so filtering by
  // one falls back to the panel view (otherwise its columns would all read NOT_APPLICABLE, since the
  // overlay below only counts enabled segments). Keeps the filter consistent with applicability.
  const activeSegment = filters.segment ? segments.find((s) => s.id === filters.segment && s.enabled) ?? null : null;
  // E12 drill-down: a measureId that is not a column of the selected (or defaulted) panel resolves
  // the roster to the panel containing it — with an omitted panel this otherwise silently serves the
  // default panel's grid and zero rows for the requested status. Unresolvable ids keep the panel; an
  // active segment keeps its own column scoping (the segment, not the panel, defines the grid there).
  const resolvedPanel: PanelId = activeSegment
    ? panel
    : (Object.keys(RUNNABLE_PANELS) as PanelId[]).find((id) => RUNNABLE_PANELS[id].includes(filters.measureId ?? "")) ?? panel;
  const measureIds = activeSegment
    ? activeSegment.measureIds.filter((m) => ACTIVE_CATALOG_MEASURE_IDS.has(m) && isRunnableMeasure(m))
    : RUNNABLE_PANELS[resolvedPanel];
  const columns: RosterColumn[] = measureIds.map((id) => ({
    measureId: id,
    // An official-only column (cms2, cms130, cms165, cms137 on the pilot) has no authored entry in
    // `MEASURES`; its name is the catalog's. Until 2026-09-10 those headers read as raw ids.
    name: MEASURES[id]?.name ?? MEASURE_CATALOG.find((m) => m.id === id)?.name ?? id,
    complianceClass: MEASURE_BINDINGS[id]?.complianceClass ?? "RECURRING",
  }));

  // 1) latest population run per panel measure → its run id, from the RUNS table (O(measures) rows;
  //    `listLatestPopulationRuns`). Excludes single-subject CASE/EMPLOYEE reruns AND in-flight RUNNING
  //    runs — an async ALL_PROGRAMS/SITE run persists each outcome before it finalizes, so without the
  //    terminal-status guard the roster could pick a partial in-flight run and surface partial
  //    statuses/NA (matches programOverview / order proposals). Until 2026-09-10 this step read every
  //    winning run's rows (120,000 on the pilot, with no evidence) to learn six run ids.
  // excludeScale: the population-scale tenant (~120k rows) is excluded IN SQL — the roster is the
  // live directory grid (E13 PR-2 scope excludes scale), and a seed:scale run must never become a
  // measure's "latest population run" here (it would both load 120k rows and show NA for everyone).
  // excludeTrendHistory (Fable M16): the backdated synthetic trend rows are always older than each
  // measure's latest real run (the seeding invariant), so they are never a winner.
  const winners = await deps.outcomeStore.listLatestPopulationRuns(measureIds, { excludeScale: true, excludeTrendHistory: true });
  const runByMeasure = new Map<string, string>();
  for (const w of winners) {
    if (!isPopulationRun(w.runScopeType) || !isCompletedRun(w.runStatus)) continue; // redundant guard (defense-in-depth)
    if (!runByMeasure.has(w.measureId)) runByMeasure.set(w.measureId, w.runId);
  }

  // 2) per measure: load that run's outcomes for THAT measure, with evidence → cell per subject. The
  //    measure filter is pushed into SQL (`listOutcomes(runId, { measureId })`): an ALL_PROGRAMS run
  //    holds every measure, and the old read took the whole run — every measure's evidence, 120,000
  //    rows on the pilot — once, to serve the panel's columns; that was the roster's cold cost.
  const cellByMeasureSubject = new Map<string, Map<string, RosterCell>>();
  for (const m of measureIds) {
    const runId = runByMeasure.get(m);
    if (!runId) {
      cellByMeasureSubject.set(m, new Map());
      continue;
    }
    // Reuse the derived cells for this measure's latest (immutable) run — skips the evidence load +
    // derive on repeat requests. The cached cells are read-only downstream (assembled by reference
    // into rows, never mutated), so sharing the map across requests is safe.
    const cached = deps.cellCache?.get(m);
    if (cached && cached.runId === runId) {
      cellByMeasureSubject.set(m, cached.cells);
      continue;
    }
    const cells = new Map<string, RosterCell>();
    for (const o of await deps.outcomeStore.listOutcomes(runId, { measureId: m })) {
      if (o.measureId !== m) continue; // a fake that ignores the filter still yields the right cells
      // Freeze the cell: cached cells are shared BY REFERENCE across requests (and assembled by
      // reference into each response's rows), so any accidental post-build mutation would silently
      // corrupt another request's view. Freezing makes that a loud throw instead — enforcing the
      // read-only invariant this cache relies on.
      cells.set(o.subjectId, Object.freeze({ ...deriveCell(o.status, o.evidence, m, o.evaluationPeriod), evidenceRef: { runId, outcomeId: o.id } }));
    }
    deps.cellCache?.set(m, { runId, cells }); // supersedes any older run's entry for this measure (bounded to #measures)
    cellByMeasureSubject.set(m, cells);
  }
  // The request-local directory: the static one, plus (seam on) the live subjects seen in the
  // columns' winning runs — the cell maps' keys, cached or freshly derived, so no extra read. The
  // rehydration used to draw on every measure's winning rows; it now draws on the columns shown,
  // which is the same set on every deployment that runs (the seam is off on both live stacks).
  const seen: { subjectId: string }[] = [];
  for (const cells of cellByMeasureSubject.values()) for (const subjectId of cells.keys()) seen.push({ subjectId });
  const directory = directoryForRows(seen, isWebChartConfigured(deps.webChartEnv ?? {}), deps.webChartEnv, DIRECTORY);

  // 3) assemble rows over the whole directory; NA where a measure has no cell for the subject.
  //    Then apply the E11.3 applicability overlay: a measure the subject is in NO enabled segment for
  //    becomes NOT_APPLICABLE (out-of-cohort wins over any real outcome; no evidenceRef). With zero
  //    enabled segments `isApplicable` is always true ⇒ no overlay (today's behavior).
  let rows: RosterRow[] = directory.employees.map((emp) => {
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
        tenantId: emp.tenantId, tenantName: directory.tenantById(emp.tenantId)?.name ?? emp.tenantId,
        providerId: emp.providerId ?? null,
        // An id that resolves to no provider row keeps the id as its own name, rather than rendering
        // blank over a patient who does have an attributed clinician.
        providerName: emp.providerId ? (directory.providerById(emp.providerId)?.name ?? emp.providerId) : null,
        payer: emp.payer ?? null,
        payerName: emp.payer ? payerNameOf(emp.payer) : null,
      },
      cells,
    };
  });

  // 3b) segment filter: scope rows to the active segment's cohort (before site/role/search/status + paging).
  if (activeSegment) {
    rows = rows.filter((r) => {
      const e = directory.employeeById(r.subject.externalId);
      return e ? matchesCohort(e, activeSegment) : false;
    });
  }

  // 4) filters (tenant/site/role/search/status), then page.
  if (filters.tenant) rows = rows.filter((r) => r.subject.tenantId === filters.tenant);
  if (filters.site) rows = rows.filter((r) => r.subject.site === filters.site);
  // The panel filters, through the shared predicate so the roster, the cases route, the exports and the
  // MCP tool cannot disagree about what "65+" — or "Medicare" — means. `filters` is passed WHOLE: the
  // version that rebuilt an object from three named fields dropped every filter added afterwards.
  if (hasActiveSubjectFilters(filters)) {
    rows = rows.filter((r) => matchesSubjectFilters(directory.employeeById(r.subject.externalId), filters));
  }
  if (filters.role) rows = rows.filter((r) => r.subject.role === filters.role);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    rows = rows.filter((r) => r.subject.name.toLowerCase().includes(q) || r.subject.externalId.toLowerCase().includes(q));
  }
  // A patient the measure in scope does not describe is not a gap and is not work (ADR-078), so a
  // roster scoped to ONE measure and no particular status drops them rather than greying them: a
  // greyed row still occupies a work list.
  //
  // Bounded three ways, and the third is the one that took a review to see. It needs a single measure
  // in scope — on the whole panel the row stays, because a patient outside CMS125's population may be
  // OVERDUE on CMS122 and hiding the row would hide the gap. It reports what it withheld, rather than
  // serving a quietly shorter list. And it does NOT apply when a status is asked for: every
  // drill-down carries one (`status=OVERDUE`, `MISSING_DATA`, …), the status filter below already
  // excludes an OUT_OF_POPULATION cell from every one of those buckets, so the drop would be a no-op
  // whose COUNT still described the pre-status set — "14 patients (8,143 not in this measure's
  // population)" over an OVERDUE list, which reads as 8,143 more overdue patients withheld. A number
  // that does not describe the list beside it is the defect this exists to prevent, inverted.
  // `status=OUT_OF_POPULATION` is therefore answered by the status filter alone.
  let notInPopulation = 0;
  if (filters.measureId && !filters.status) {
    const before = rows.length;
    rows = rows.filter((r) => r.cells[filters.measureId!]?.status !== "OUT_OF_POPULATION");
    notInPopulation = before - rows.length;
  }

  if (filters.status) {
    const s = filters.status.toUpperCase();
    rows = filters.measureId
      ? rows.filter((r) => r.cells[filters.measureId!]?.status === s)
      : rows.filter((r) => Object.values(r.cells).some((c) => c.status === s));
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
  return { panel: resolvedPanel, availablePanels: AVAILABLE_PANELS, columns, rows: rows.slice(start, start + pageSize), total, notInPopulation };
}
