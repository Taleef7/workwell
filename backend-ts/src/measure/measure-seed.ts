/**
 * Seeds the persisted MeasureStore from MEASURE_CATALOG on first use (#107 authoring) — the
 * store becomes the source of truth so create/lifecycle mutations are reflected in reads.
 * Version ids are the stable `<measureId>-<version>` form (so version-scoped Studio actions
 * keep their ids across the static→persisted move); per-status tier timestamps preserve the
 * Active-first list ordering until real authoring timestamps accrue.
 */
import { MEASURE_CATALOG, type MeasureStatus } from "./measure-catalog.ts";
import type { MeasureStore } from "../stores/measure-store.ts";

// Newest-first per status (Active recently activated), mirroring Java COALESCE(activated_at, …).
const TIER: Record<MeasureStatus, string> = {
  Active: "2026-06-10T00:00:00.000Z",
  Approved: "2026-04-01T00:00:00.000Z",
  Draft: "2026-02-01T00:00:00.000Z",
  Deprecated: "2025-06-01T00:00:00.000Z",
};

/** Idempotent: seeds the catalog only when the store is empty. `cqlOf` reconstructs CQL for runnable measures. */
export async function seedMeasureStore(store: MeasureStore, cqlOf: (measureId: string) => string): Promise<void> {
  if (!(await store.isEmpty())) return;
  for (const m of MEASURE_CATALOG) {
    await store.seedMeasure({
      measureId: m.id,
      name: m.name,
      policyRef: m.policyRef,
      owner: m.owner,
      tags: [...m.tags],
      versionId: `${m.id}-${m.version}`,
      version: m.version,
      status: m.status,
      spec: m.spec,
      cqlText: cqlOf(m.id),
      compileStatus: m.compileStatus,
      createdAt: TIER[m.status],
      changeSummary: "Seeded measure version",
    });
  }
}
