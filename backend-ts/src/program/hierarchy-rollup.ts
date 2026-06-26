/**
 * Hierarchy rollup (#74 E4; multi-tenant #185 E13 PR-1) — the
 * all→tenant→enterprise→location→provider→patient tree for the multi-level dashboard.
 * Aggregates the SAME outcome rows the programs overview uses (latest population run per Active
 * measure; single-subject CASE/EMPLOYEE reruns excluded) into a node tree where parent count totals
 * equal the sum of their children at every level — now reconciling across systems (All = Σ tenants).
 *
 * No DB schema: the hierarchy is resolved at read-time from the synthetic directory
 * (employee.tenantId = system, employee.site = location, employee.providerId = provider). Subjects
 * that don't resolve to a directory employee can't be placed in the tree and are skipped.
 * `?tenant=<id>` returns that single tenant's subtree as the root (E13).
 */
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { employeeById, providerById, tenantById, enterpriseForTenant } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { day, isPopulationRun, latestRunRows, round1 } from "./rollup-shared.ts";

export type HierarchyLevel = "all" | "tenant" | "enterprise" | "location" | "provider" | "patient";

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
  /** Scope the tree to one tenant/system; the returned root is that tenant's subtree (#185 E13). */
  tenant?: string | null;
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

  const tenantFilter = filters.tenant?.trim() || null;

  // Accumulate bottom-up with TENANT-QUALIFIED keys so same-named locations/providers never merge
  // across systems (E13: each WebChart system is its own tenant above enterprise).
  const provTotals = new Map<string, MutableTotals>(); // key: `${tenantId}|${providerId}`
  const locTotals = new Map<string, MutableTotals>(); // key: `${tenantId}|${location}`
  const entTotals = new Map<string, MutableTotals>(); // key: tenantId (1 enterprise per tenant in PR-1)
  const patientsByProvKey = new Map<string, HierarchyNode[]>();
  const tenantsSeen = new Set<string>();

  for (const [subjectId, t] of byPatient) {
    if (t.evaluated === 0 && t.openCases === 0) continue;
    const emp = employeeById(subjectId)!;
    if (tenantFilter && emp.tenantId !== tenantFilter) continue;
    const prov = providerById(emp.providerId);
    const location = prov?.location ?? "Unknown";
    const provKey = `${emp.tenantId}|${emp.providerId}`;
    const locKey = `${emp.tenantId}|${location}`;
    tenantsSeen.add(emp.tenantId);
    const node: HierarchyNode = {
      level: "patient", id: subjectId, name: emp.name, parentId: emp.providerId, totals: seal(t), children: [],
    };
    (patientsByProvKey.get(provKey) ?? patientsByProvKey.set(provKey, []).get(provKey)!).push(node);
    accumulate(provTotals.get(provKey) ?? provTotals.set(provKey, zero()).get(provKey)!, t);
    accumulate(locTotals.get(locKey) ?? locTotals.set(locKey, zero()).get(locKey)!, t);
    accumulate(entTotals.get(emp.tenantId) ?? entTotals.set(emp.tenantId, zero()).get(emp.tenantId)!, t);
  }

  // provider nodes grouped under tenant-qualified location keys
  const provsByLocKey = new Map<string, HierarchyNode[]>();
  for (const [provKey, patients] of patientsByProvKey) {
    const [tenantId, providerId] = provKey.split("|") as [string, string];
    const prov = providerById(providerId);
    const location = prov?.location ?? "Unknown";
    const locKey = `${tenantId}|${location}`;
    const provNode: HierarchyNode = {
      level: "provider", id: providerId, name: prov?.name ?? providerId, parentId: location,
      totals: seal(provTotals.get(provKey)!),
      children: patients.sort((a, b) => a.id.localeCompare(b.id)),
    };
    (provsByLocKey.get(locKey) ?? provsByLocKey.set(locKey, []).get(locKey)!).push(provNode);
  }

  // location nodes grouped under tenant (for the per-tenant enterprise subtree)
  const locsByTenant = new Map<string, HierarchyNode[]>();
  for (const [locKey, provs] of provsByLocKey) {
    const [tenantId, location] = locKey.split("|") as [string, string];
    const locNode: HierarchyNode = {
      level: "location", id: location, name: location, parentId: tenantId,
      totals: seal(locTotals.get(locKey)!),
      children: provs.sort((a, b) => a.id.localeCompare(b.id)),
    };
    (locsByTenant.get(tenantId) ?? locsByTenant.set(tenantId, []).get(tenantId)!).push(locNode);
  }

  // enterprise node (1 per tenant) wrapped in a tenant node
  const tenantNodes: HierarchyNode[] = [...tenantsSeen].sort().map((tenantId): HierarchyNode => {
    const ent = enterpriseForTenant(tenantId);
    const tenantTotals = seal(entTotals.get(tenantId)!);
    const locations = (locsByTenant.get(tenantId) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    const enterpriseNode: HierarchyNode = {
      level: "enterprise", id: ent?.id ?? tenantId, name: ent?.name ?? tenantId, parentId: tenantId,
      totals: tenantTotals, children: locations,
    };
    return {
      level: "tenant", id: tenantId, name: tenantById(tenantId)?.name ?? tenantId, parentId: "all",
      totals: tenantTotals, children: [enterpriseNode],
    };
  });

  // tenant-filtered → that single tenant subtree IS the root (empty zero-node if it has no data)
  if (tenantFilter) {
    return (
      tenantNodes.find((t) => t.id === tenantFilter) ?? {
        level: "tenant", id: tenantFilter, name: tenantById(tenantFilter)?.name ?? tenantFilter,
        parentId: "all", totals: seal(zero()), children: [],
      }
    );
  }

  const allTotals = zero();
  for (const t of entTotals.values()) accumulate(allTotals, t);
  return {
    level: "all", id: "all", name: "All Systems", parentId: null,
    totals: seal(allTotals), children: tenantNodes,
  };
}
