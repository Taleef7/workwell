/**
 * Hierarchy rollup (#74 E4) — the enterprise→location→provider→patient tree for the
 * multi-level dashboard. Aggregates the SAME outcome rows the programs overview uses
 * (latest population run per Active measure; single-subject CASE/EMPLOYEE reruns excluded)
 * into a node tree where parent count totals equal the sum of their children at every level.
 *
 * No DB schema: the hierarchy is resolved at read-time from the synthetic directory
 * (employee.site = location, employee.providerId = provider). Subjects that don't resolve
 * to a directory employee can't be placed in the tree and are skipped.
 */
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { ENTERPRISE, employeeById, providerById } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { day, isPopulationRun, latestRunRows, round1 } from "./rollup-shared.ts";

export type HierarchyLevel = "enterprise" | "location" | "provider" | "patient";

export interface HierarchyTotals {
  evaluated: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  complianceRate: number;
  openCases: number;
}

export interface HierarchyNode {
  level: HierarchyLevel;
  id: string;
  name: string;
  parentId: string | null;
  totals: HierarchyTotals;
  children: HierarchyNode[];
}

export interface HierarchyDeps {
  outcomeStore: OutcomeStore;
  caseStore: CaseStore;
}

export interface HierarchyFilters {
  measureId?: string | null;
  from?: string | null;
  to?: string | null;
}

interface MutableTotals {
  evaluated: number; compliant: number; dueSoon: number; overdue: number;
  missingData: number; excluded: number; openCases: number;
}
const zero = (): MutableTotals => ({ evaluated: 0, compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, excluded: 0, openCases: 0 });
const addStatus = (t: MutableTotals, status: string): void => {
  t.evaluated++;
  if (status === "COMPLIANT") t.compliant++;
  else if (status === "DUE_SOON") t.dueSoon++;
  else if (status === "OVERDUE") t.overdue++;
  else if (status === "MISSING_DATA") t.missingData++;
  else if (status === "EXCLUDED") t.excluded++;
};
const seal = (t: MutableTotals): HierarchyTotals => ({ ...t, complianceRate: round1(t.compliant, t.evaluated) });
const accumulate = (acc: MutableTotals, t: MutableTotals): void => {
  acc.evaluated += t.evaluated; acc.compliant += t.compliant; acc.dueSoon += t.dueSoon;
  acc.overdue += t.overdue; acc.missingData += t.missingData; acc.excluded += t.excluded; acc.openCases += t.openCases;
};

export async function buildHierarchyRollup(deps: HierarchyDeps, filters: HierarchyFilters): Promise<HierarchyNode> {
  const from = filters.from?.trim() || undefined;
  const to = filters.to?.trim() || undefined;
  const measureId = filters.measureId?.trim() || null;

  const active = MEASURE_CATALOG.filter((m) => m.status === "Active").map((m) => m.id);
  const scopeMeasures = measureId ? (active.includes(measureId) ? [measureId] : []) : active;

  const byPatient = new Map<string, MutableTotals>();
  const ensure = (subjectId: string): MutableTotals | null => {
    if (!employeeById(subjectId)) return null;
    return byPatient.get(subjectId) ?? byPatient.set(subjectId, zero()).get(subjectId)!;
  };

  if (scopeMeasures.length > 0) {
    const allRows = (await deps.outcomeStore.listOutcomesWithRun({ from, to })).filter((r) => isPopulationRun(r.runScopeType));
    const byMeasure = new Map<string, OutcomeWithRun[]>();
    for (const r of allRows) (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
    for (const m of scopeMeasures) {
      for (const r of latestRunRows(byMeasure.get(m) ?? [])) {
        const acc = ensure(r.subjectId);
        if (acc) addStatus(acc, r.status);
      }
    }
    const openCases = await deps.caseStore.listCases({ statuses: ["OPEN"], measureId: measureId ?? undefined, limit: 100000 });
    for (const c of openCases) {
      if (from && day(c.createdAt) < day(from)) continue;
      if (to && day(c.createdAt) > day(to)) continue;
      const acc = ensure(c.employeeId);
      if (acc) acc.openCases++;
    }
  }

  const providerTotals = new Map<string, MutableTotals>();
  const locationTotals = new Map<string, MutableTotals>();
  const patientsByProvider = new Map<string, HierarchyNode[]>();
  const ent = zero();

  for (const [subjectId, t] of byPatient) {
    if (t.evaluated === 0 && t.openCases === 0) continue;
    const emp = employeeById(subjectId)!;
    const node: HierarchyNode = {
      level: "patient", id: subjectId, name: emp.name, parentId: emp.providerId, totals: seal(t), children: [],
    };
    (patientsByProvider.get(emp.providerId) ?? patientsByProvider.set(emp.providerId, []).get(emp.providerId)!).push(node);
    const pt = providerTotals.get(emp.providerId) ?? providerTotals.set(emp.providerId, zero()).get(emp.providerId)!;
    const lt = locationTotals.get(emp.site) ?? locationTotals.set(emp.site, zero()).get(emp.site)!;
    accumulate(pt, t);
    accumulate(lt, t);
    accumulate(ent, t);
  }

  const locationNodes = new Map<string, HierarchyNode[]>();
  for (const [providerId, patients] of patientsByProvider) {
    const prov = providerById(providerId);
    const location = prov?.location ?? "Unknown";
    const provNode: HierarchyNode = {
      level: "provider", id: providerId, name: prov?.name ?? providerId, parentId: location,
      totals: seal(providerTotals.get(providerId)!),
      children: patients.sort((a, b) => a.id.localeCompare(b.id)),
    };
    (locationNodes.get(location) ?? locationNodes.set(location, []).get(location)!).push(provNode);
  }

  const locationChildren: HierarchyNode[] = [...locationNodes.entries()]
    .map(([location, providers]): HierarchyNode => ({
      level: "location", id: location, name: location, parentId: ENTERPRISE.id,
      totals: seal(locationTotals.get(location)!),
      children: providers.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    level: "enterprise", id: ENTERPRISE.id, name: ENTERPRISE.name, parentId: null,
    totals: seal(ent), children: locationChildren,
  };
}
