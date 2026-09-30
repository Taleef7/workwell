/**
 * E16 — quality snapshot pure core. Reduces a population run's live outcomes (+ the pre-aggregated
 * scale tenant) into per-(measure, period, scope) `QualitySnapshotInput` rows: numerator/denominator
 * + the 5 bucket counts at every scope level (all → tenant → site → provider), reconciling
 * All = Σ tenants = Σ sites = Σ providers by construction (each unit is counted once per level).
 *
 * Pure + dependency-injected (`resolveScope`) — no DB, no employee-catalog/scale import — so it tests
 * in isolation and the orchestration (`materialize-run.ts`) wires the real directory + scale aggregation.
 * Mirrors `program/hierarchy-rollup.ts` accumulation (same status buckets, same scope keying); the scale
 * groups arrive already aggregated (`OutcomeStore.aggregateScaleRun`), so row count is O(scopes), never
 * O(subjects). Descriptive only — it counts what CQL already decided, never re-derives compliance.
 */
import type { QualitySnapshotInput, QualityScopeLevel } from "../stores/quality-snapshot-store.ts";

/** A live subject's place in the hierarchy (tenant → site/location → provider). */
export interface ScopeRef {
  tenantId: string;
  site: string;
  providerId: string;
}

/** A pre-aggregated scale-tenant group (one (location, provider, status) bucket; cf. ScaleGroupCount). */
export interface ScaleGroup {
  locationId: string;
  providerId: string;
  status: string;
  count: number;
}

export interface BuildSnapshotInput {
  measureId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  sourceRunId: string | null;
  computedAt: string;
  /**
   * Live-evaluated outcomes (the in-directory tenants) — subjectId, CQL status bucket, and whether the
   * measure's own logic put the subject OUTSIDE its population (ADR-079). Such a subject is persisted as
   * MISSING_DATA but is not a gap: it is counted into `notInPopulation`, never into `total` (#676).
   */
  liveOutcomes: { subjectId: string; status: string; outOfPopulation?: boolean }[];
  /** Resolve a live subject to its scope; `null` ⇒ skip (unknown subject), as the hierarchy rollup does. */
  resolveScope: (subjectId: string) => ScopeRef | null;
  /**
   * The scale tenant, already aggregated to (location, provider, status) groups. Omit if none. Its rows
   * are seeded by `backfill-scale` for AUTHORED measures with synthetic statuses, so none is ever out of
   * a measure's population: the groups carry no such flag because they cannot hold such a row.
   */
  scale?: { tenantId: string; groups: ScaleGroup[] };
  /**
   * Whether these outcomes KNOW which subjects are out of the population (#676). Default true: a run's
   * persisted outcomes carry the flag. False where they cannot: then the rows record NULL, the old
   * basis, and the screens refuse them rather than certify a denominator nobody checked.
   */
  basisKnown?: boolean;
}

interface Acc {
  tenantId: string | null;
  total: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  notInPopulation: number;
}

const zeroAcc = (tenantId: string | null): Acc => ({
  tenantId,
  total: 0,
  compliant: 0,
  dueSoon: 0,
  overdue: 0,
  missingData: 0,
  excluded: 0,
  notInPopulation: 0,
});

/**
 * Bucket one (status, count) into an accumulator — mirrors hierarchy-rollup `addStatus`/`add`. An
 * out-of-population subject is counted apart and never into `total`, so it never reaches `denominator`
 * (ADR-079, as every rate computed from outcomes already does; #676).
 */
function addStatus(acc: Acc, status: string, count: number, outOfPopulation = false): void {
  if (outOfPopulation) {
    acc.notInPopulation += count;
    return;
  }
  acc.total += count;
  switch (status.toUpperCase()) {
    case "COMPLIANT":
      acc.compliant += count;
      break;
    case "DUE_SOON":
      acc.dueSoon += count;
      break;
    case "OVERDUE":
      acc.overdue += count;
      break;
    case "MISSING_DATA":
      acc.missingData += count;
      break;
    case "EXCLUDED":
      acc.excluded += count;
      break;
    // Unrecognized statuses contribute to `total` (→ denominator) only; CQL emits exactly the 5 buckets.
  }
}

export function buildSnapshotRows(input: BuildSnapshotInput): QualitySnapshotInput[] {
  const all = zeroAcc(null);
  const tenants = new Map<string, Acc>();
  const sites = new Map<string, Acc>();
  const providers = new Map<string, Acc>();

  const at = (map: Map<string, Acc>, key: string, tenantId: string): Acc => {
    let acc = map.get(key);
    if (!acc) {
      acc = zeroAcc(tenantId);
      map.set(key, acc);
    }
    return acc;
  };

  /** Count one (tenant, site, provider, status, n) into every scope level it belongs to. */
  const record = (tenantId: string, site: string, providerId: string, status: string, count: number, outOfPopulation = false): void => {
    addStatus(all, status, count, outOfPopulation);
    addStatus(at(tenants, tenantId, tenantId), status, count, outOfPopulation);
    addStatus(at(sites, `${tenantId}|${site}`, tenantId), status, count, outOfPopulation);
    addStatus(at(providers, `${tenantId}|${site}|${providerId}`, tenantId), status, count, outOfPopulation);
  };

  for (const o of input.liveOutcomes) {
    const scope = input.resolveScope(o.subjectId);
    if (!scope) continue; // unresolvable subject — skipped (mirrors the rollup's `ensure` gate)
    record(scope.tenantId, scope.site, scope.providerId, o.status, 1, o.outOfPopulation === true);
  }

  if (input.scale) {
    for (const g of input.scale.groups) {
      record(input.scale.tenantId, g.locationId, g.providerId, g.status, g.count);
    }
  }

  const rows: QualitySnapshotInput[] = [];
  const emit = (scopeLevel: QualityScopeLevel, scopeId: string, acc: Acc): void => {
    rows.push({
      measureId: input.measureId,
      period: input.period,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      scopeLevel,
      scopeId,
      tenantId: acc.tenantId,
      numerator: acc.compliant,
      denominator: acc.total - acc.excluded,
      compliant: acc.compliant,
      dueSoon: acc.dueSoon,
      overdue: acc.overdue,
      missingData: acc.missingData,
      excluded: acc.excluded,
      sourceRunId: input.sourceRunId,
      computedAt: input.computedAt,
      // A number: computed without the out-of-population subjects. NULL only where the caller could not
      // tell them apart (`basisKnown: false`).
      notInPopulation: input.basisKnown === false ? null : acc.notInPopulation,
    });
  };

  emit("all", "ALL", all);
  for (const key of [...tenants.keys()].sort()) emit("tenant", key, tenants.get(key)!);
  for (const key of [...sites.keys()].sort()) emit("site", key, sites.get(key)!);
  for (const key of [...providers.keys()].sort()) emit("provider", key, providers.get(key)!);

  return rows;
}
