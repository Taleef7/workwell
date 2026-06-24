/**
 * Roster read model (E10.2) — `GET /api/compliance/roster`. Rows = every directory subject, columns =
 * the selected panel's Active measures, each cell = the E10.5 display state + method derived from the
 * subject's outcome in that measure's LATEST population run (NA when there is none). Read-time; no schema.
 * Reuses the "latest population run per measure" path the hierarchy rollup uses (`listOutcomesWithRun` +
 * `latestRunRows`) and loads evidence per run via `listOutcomes` (cached by run id).
 */
import type { OutcomeStore, OutcomeWithRun, OutcomeRecord } from "../stores/outcome-store.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { isCompletedRun, isPopulationRun, latestRunRows } from "../program/rollup-shared.ts";
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
  subject: { externalId: string; name: string; role: string; site: string };
  cells: Record<string, RosterCell>;
}
export interface Roster {
  panel: PanelId;
  columns: RosterColumn[];
  rows: RosterRow[];
  total: number;
}

export interface RosterDeps {
  outcomeStore: OutcomeStore;
}
export interface RosterFilters {
  panel?: string | null;
  status?: string | null;
  site?: string | null;
  role?: string | null;
  q?: string | null;
  page?: number;
  pageSize?: number;
}

export async function buildRoster(deps: RosterDeps, filters: RosterFilters): Promise<Roster> {
  const panel: PanelId = filters.panel && isPanelId(filters.panel) ? filters.panel : DEFAULT_PANEL;
  const active = new Set(MEASURE_CATALOG.filter((m) => m.status === "Active").map((m) => m.id));
  const measureIds = PANELS[panel].filter((m) => active.has(m));
  const columns: RosterColumn[] = measureIds.map((id) => ({
    measureId: id,
    name: MEASURES[id]?.name ?? id,
    complianceClass: MEASURE_BINDINGS[id]?.complianceClass ?? "RECURRING",
  }));

  // 1) latest population run per panel measure (no evidence) → its run id. Exclude single-subject
  //    CASE/EMPLOYEE reruns AND in-flight RUNNING runs — an async ALL_PROGRAMS/SITE run persists each
  //    outcome before it finalizes, so without the terminal-status guard `latestRunRows` could pick a
  //    partial in-flight run and surface partial statuses/NA (matches programOverview / order proposals).
  const popRows = (await deps.outcomeStore.listOutcomesWithRun({})).filter(
    (r) => isPopulationRun(r.runScopeType) && isCompletedRun(r.runStatus),
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
    const cells = new Map<string, RosterCell>();
    cellByMeasureSubject.set(m, cells);
    if (latest.length === 0) continue;
    const runId = latest[0]!.runId;
    for (const o of await loadRun(runId)) {
      if (o.measureId !== m) continue;
      cells.set(o.subjectId, { ...deriveCell(o.status, o.evidence, m, o.evaluationPeriod), evidenceRef: { runId, outcomeId: o.id } });
    }
  }

  // 3) assemble rows over the whole directory; NA where a measure has no cell for the subject.
  let rows: RosterRow[] = EMPLOYEES.map((emp) => {
    const cells: Record<string, RosterCell> = {};
    for (const m of measureIds) {
      cells[m] = cellByMeasureSubject.get(m)?.get(emp.externalId) ?? { status: "NA", method: "Not evaluated" };
    }
    return { subject: { externalId: emp.externalId, name: emp.name, role: emp.role, site: emp.site }, cells };
  });

  // 4) filters (site/role/search/status), then page.
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

  const total = rows.length;
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(filters.pageSize ?? 50), 200));
  const start = (page - 1) * pageSize;
  return { panel, columns, rows: rows.slice(start, start + pageSize), total };
}
