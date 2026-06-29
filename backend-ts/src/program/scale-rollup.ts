/**
 * Scale-tenant rollup subtree (#185 E13 PR-2). Builds the mhn tenant→enterprise→location→provider tree
 * from the bounded `ScaleGroupCount` aggregation (NOT per-subject rows). Provider is a LEAF — the 120k
 * patients are deliberately not enumerated. Node names come from scale-structure.ts.
 */
import type { HierarchyNode, HierarchyTotals } from "./hierarchy-rollup.ts";
import type { ScaleGroupCount } from "../stores/outcome-store.ts";
import { SCALE_TENANT, SCALE_LOCATIONS, scaleProvidersFor, enterpriseNameForScale } from "../engine/synthetic/scale-structure.ts";
import { round1 } from "./rollup-shared.ts";

interface Mut { evaluated: number; compliant: number; dueSoon: number; overdue: number; missingData: number; excluded: number; openCases: number; }
const zero = (): Mut => ({ evaluated: 0, compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, excluded: 0, openCases: 0 });
const add = (t: Mut, status: string, c: number): void => {
  t.evaluated += c;
  if (status === "COMPLIANT") t.compliant += c;
  else if (status === "DUE_SOON") t.dueSoon += c;
  else if (status === "OVERDUE") t.overdue += c;
  else if (status === "MISSING_DATA") t.missingData += c;
  else if (status === "EXCLUDED") t.excluded += c;
};
const acc = (a: Mut, b: Mut): void => {
  a.evaluated += b.evaluated; a.compliant += b.compliant; a.dueSoon += b.dueSoon; a.overdue += b.overdue;
  a.missingData += b.missingData; a.excluded += b.excluded; a.openCases += b.openCases;
};
const seal = (t: Mut): HierarchyTotals => ({ ...t, complianceRate: round1(t.compliant, t.evaluated) });

/** Build the mhn tenant subtree from grouped counts; null when there is no scale data. */
export function buildScaleSubtree(groups: ScaleGroupCount[]): HierarchyNode | null {
  if (groups.length === 0) return null;

  const provTotals = new Map<string, Mut>(); // key: `${loc}|${prov}`
  for (const g of groups) {
    const k = `${g.locationId}|${g.providerId}`;
    add(provTotals.get(k) ?? provTotals.set(k, zero()).get(k)!, g.status, g.count);
  }

  const provsByLoc = new Map<string, HierarchyNode[]>();
  const locTotals = new Map<string, Mut>();
  for (const [k, t] of provTotals) {
    const [locId, provId] = k.split("|") as [string, string];
    const provName = scaleProvidersFor(locId).find((p) => p.id === provId)?.name ?? provId;
    // Use a location-qualified id so P00 in L00 and P00 in L01 never share a tree key (the
    // hierarchy UI keys expansion state as `${level}:${id}` — duplicate bare provId would cause
    // React to reconcile the wrong row when multiple mhn locations are open simultaneously).
    const provNode: HierarchyNode = { level: "provider", id: `${locId}:${provId}`, name: provName, parentId: locId, totals: seal(t), children: [] };
    (provsByLoc.get(locId) ?? provsByLoc.set(locId, []).get(locId)!).push(provNode);
    acc(locTotals.get(locId) ?? locTotals.set(locId, zero()).get(locId)!, t);
  }

  const entTotals = zero();
  const locationChildren: HierarchyNode[] = [...provsByLoc.entries()]
    .map(([locId, provs]): HierarchyNode => {
      const lt = locTotals.get(locId)!;
      acc(entTotals, lt);
      const locName = SCALE_LOCATIONS.find((l) => l.id === locId)?.name ?? locId;
      return {
        level: "location", id: locId, name: locName, parentId: SCALE_TENANT.id,
        totals: seal(lt), children: provs.sort((a, b) => a.id.localeCompare(b.id)),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const tenantTotals = seal(entTotals);
  const enterpriseNode: HierarchyNode = {
    level: "enterprise", id: SCALE_TENANT.id, name: enterpriseNameForScale(), parentId: SCALE_TENANT.id,
    totals: tenantTotals, children: locationChildren,
  };
  return {
    level: "tenant", id: SCALE_TENANT.id, name: SCALE_TENANT.name, parentId: "all",
    totals: tenantTotals, children: [enterpriseNode],
  };
}
