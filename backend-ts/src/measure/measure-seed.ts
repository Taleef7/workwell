/**
 * Seeds the persisted MeasureStore from MEASURE_CATALOG on first use (#107 authoring) — the
 * store becomes the source of truth so create/lifecycle mutations are reflected in reads.
 * Version ids are the stable `<measureId>-<version>` form (so version-scoped Studio actions
 * keep their ids across the static→persisted move); per-status tier timestamps preserve the
 * Active-first list ordering until real authoring timestamps accrue.
 */
import { MEASURE_CATALOG, type MeasureStatus } from "./measure-catalog.ts";
import type { MeasureStore } from "../stores/measure-store.ts";
import type { AppendAuditInput, CaseEventStore } from "../stores/case-event-store.ts";

// Newest-first per status (Active recently activated), mirroring Java COALESCE(activated_at, …).
const TIER: Record<MeasureStatus, string> = {
  Active: "2026-06-10T00:00:00.000Z",
  Approved: "2026-04-01T00:00:00.000Z",
  Draft: "2026-02-01T00:00:00.000Z",
  Deprecated: "2025-06-01T00:00:00.000Z",
};

const LEGACY_OFFICIAL_IDS = [
  { legacyId: "cms2v15", catalogId: "cms2" },
  { legacyId: "cms130v14", catalogId: "cms130" },
  { legacyId: "cms165v14", catalogId: "cms165" },
] as const;

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, i) => deepEqual(value, right[i]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]));
};

function isUnmodifiedLegacySeed(
  row: Awaited<ReturnType<MeasureStore["getLatest"]>>,
  catalogId: string,
  legacyId: string,
  expectedStatus?: string,
): boolean {
  const catalog = MEASURE_CATALOG.find((m) => m.id === catalogId);
  if (!row || !catalog) return false;
  return (
    row.measureId === legacyId &&
    row.name === catalog.name &&
    row.policyRef === catalog.policyRef &&
    row.owner === catalog.owner &&
    deepEqual(row.tags, catalog.tags) &&
    row.versionId === `${legacyId}-${catalog.version}` &&
    row.version === catalog.version &&
    row.status === (expectedStatus ?? catalog.status) &&
    deepEqual(row.spec, catalog.spec) &&
    row.cqlText === "" &&
    row.compileStatus === catalog.compileStatus &&
    row.changeSummary === "Seeded measure version" &&
    row.approvedBy === null &&
    row.activatedAt === null &&
    row.createdAt === TIER[catalog.status] &&
    (expectedStatus === "Deprecated" || row.updatedAt === TIER[catalog.status])
  );
}

async function deprecateLegacyOfficialRows(store: MeasureStore, events: CaseEventStore): Promise<void> {
  for (const { legacyId, catalogId } of LEGACY_OFFICIAL_IDS) {
    const row = await store.getLatest(legacyId);
    const reason = `superseded by ${catalogId} (catalog id rename, 2026-09)`;
    if (!row) continue;
    const audit: AppendAuditInput = {
      eventType: "MEASURE_DEPRECATED",
      entityType: "measure_version",
      entityId: row.versionId,
      actor: "system",
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: row.versionId,
      payload: { measureId: legacyId, version: row.version, reason, deprecatedBy: "system" },
    };
    if (row.status === "Deprecated") {
      if (isUnmodifiedLegacySeed(row, catalogId, legacyId, "Deprecated") && !(await events.hasAuditEvent(audit))) {
        await events.appendAudit(audit);
      }
      continue;
    }
    if (!isUnmodifiedLegacySeed(row, catalogId, legacyId)) {
      // Left alone on purpose (someone edited it), but say so: the bare row now coexists with it.
      console.warn(`[measure-seed] legacy row ${legacyId} does not match the seed fingerprint; not deprecated, ${catalogId} coexists with it`);
      continue;
    }
    await store.setVersionStatus(legacyId, row.versionId, { status: "Deprecated" });
    await events.appendAudit(audit);
  }
}

/**
 * Seeds the measure store from MEASURE_CATALOG. On a fresh (empty) store every catalog entry
 * is inserted. On an already-seeded store (e.g. the live stack) only catalog measures that are
 * MISSING from the store are inserted — existing rows are never overwritten, preserving any
 * create/lifecycle edits made since the initial seed (idempotent back-fill, #76).
 * `cqlOf` reconstructs CQL text for runnable measures.
 */
export async function seedMeasureStore(store: MeasureStore, cqlOf: (measureId: string) => string, events: CaseEventStore): Promise<void> {
  const empty = await store.isEmpty();
  await deprecateLegacyOfficialRows(store, events);
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
