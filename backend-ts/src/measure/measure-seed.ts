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

/**
 * Seeds the measure store from MEASURE_CATALOG. On a fresh (empty) store every catalog entry
 * is inserted. On an already-seeded store (e.g. the live stack) only catalog measures that are
 * MISSING from the store are inserted — existing rows are never overwritten, preserving any
 * create/lifecycle edits made since the initial seed (idempotent back-fill, #76).
 * `cqlOf` reconstructs CQL text for runnable measures.
 */
export async function seedMeasureStore(store: MeasureStore, cqlOf: (measureId: string) => string): Promise<void> {
  const empty = await store.isEmpty();
  for (const m of MEASURE_CATALOG) {
    // Fast path on a fresh store: seed everything. On an already-seeded store, back-fill ONLY
    // catalog measures missing from the store (e.g. adult_immunization, added after the initial
    // seed — #76). Never overwrite an existing row: create/lifecycle edits are the source of truth.
    if (!empty && (await store.getLatest(m.id)) !== null) continue;
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

  // Idempotent promotion backfill (E10.6): `hepatitis_b_vaccination_series` existed as an Approved,
  // catalog-only row before it became a runnable Active measure. seedMeasure() above skips existing
  // rows, so on an already-seeded store the persisted row must be promoted explicitly (status + CQL +
  // spec). Gated on the original "Approved" state so create/lifecycle edits (Draft/Deprecated/already
  // -Active) are never clobbered — and so this is a no-op on a fresh store (seeded Active above) and on
  // every subsequent boot.
  const hepb = MEASURE_CATALOG.find((m) => m.id === "hepatitis_b_vaccination_series");
  if (hepb && hepb.status === "Active") {
    const stored = await store.getLatest(hepb.id);
    if (stored && stored.status === "Approved") {
      await store.updateCql(hepb.id, cqlOf(hepb.id), hepb.compileStatus);
      await store.updateSpec(hepb.id, hepb.spec, hepb.policyRef);
      await store.setVersionStatus(hepb.id, stored.versionId, { status: "Active", activate: true });
    }
  }
}
