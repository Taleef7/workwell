/**
 * Seeds the persisted MeasureStore from MEASURE_CATALOG on first use (#107 authoring) — the
 * store becomes the source of truth so create/lifecycle mutations are reflected in reads.
 * Version ids are the stable `<measureId>-<version>` form (so version-scoped Studio actions
 * keep their ids across the static→persisted move); per-status tier timestamps preserve the
 * Active-first list ordering until real authoring timestamps accrue.
 */
import { MEASURE_CATALOG, type CatalogMeasure, type MeasureSpec, type MeasureStatus } from "./measure-catalog.ts";
import { HYPERTENSION_PRE_CHANGE_CQL } from "./hypertension-pre-change-cql.ts";
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

const HYPERTENSION_PRE_CHANGE = {
  policyRef: "HEDIS BPC / JPMC Wellness Rewards",
  spec: {
    description: "Annual blood pressure screening for employees enrolled in the wellness program.",
    eligibilityCriteria: { roleFilter: "All", siteFilter: "All Sites", programEnrollmentText: "Wellness Program" },
    exclusions: [{ label: "Medical Exemption", criteriaText: "Documented medical exemption on file" }],
    complianceWindow: "Annual",
    requiredDataElements: ["Last BP screening date", "Program enrollment", "Exemption status"],
    testFixtures: [],
  },
};

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

// The exact Draft placeholder rows the pre-MM-1b catalog seeded for the three official-only
// measures. Promotion and legacy deprecation fingerprint against these, not the current Active
// rows, so an untouched pre-change store converges while an edited row is left alone.
export const OFFICIAL_ONLY_PRE_CHANGE: Record<"cms2" | "cms130" | "cms165", MeasureSpec> = {
  cms2: {
    description: "CMS2v15 (MIPS Quality ID 134) — CMS eCQM 2026 performance period catalog entry. CQL authoring pending.",
    eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
    exclusions: [],
    complianceWindow: "Annual",
    requiredDataElements: [],
    testFixtures: [],
  },
  cms130: {
    description: "CMS130v14 (MIPS Quality ID 113) — CMS eCQM 2026 performance period catalog entry. CQL authoring pending.",
    eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
    exclusions: [],
    complianceWindow: "Annual",
    requiredDataElements: [],
    testFixtures: [],
  },
  cms165: {
    description: "CMS165v14 (MIPS Quality ID 236) — CMS eCQM 2026 performance period catalog entry. CQL authoring pending.",
    eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
    exclusions: [],
    complianceWindow: "Annual",
    requiredDataElements: [],
    testFixtures: [],
  },
};

export function matchesSeedFingerprint(
  row: Awaited<ReturnType<MeasureStore["getLatest"]>>,
  catalog: CatalogMeasure,
  expectedStatus?: string,
): boolean {
  if (!row) return false;
  return (
    row.measureId === catalog.id &&
    row.name === catalog.name &&
    row.policyRef === catalog.policyRef &&
    row.owner === catalog.owner &&
    deepEqual(row.tags, catalog.tags) &&
    row.versionId === `${catalog.id}-${catalog.version}` &&
    row.version === catalog.version &&
    row.status === (expectedStatus ?? catalog.status) &&
    deepEqual(row.spec, catalog.spec) &&
    row.cqlText === "" &&
    row.compileStatus === catalog.compileStatus &&
    row.changeSummary === "Seeded measure version" &&
    row.createdAt === TIER[catalog.status]
  );
}

// The catalog row as the pre-MM-1b seed wrote it: same identity fields, Draft placeholder
// content. Legacy deprecation and official-only promotion both fingerprint against this so an
// untouched pre-change store converges and an edited row is left alone.
const preChangeCatalog = (catalogId: string, measureId?: string): CatalogMeasure => {
  const catalog = MEASURE_CATALOG.find((m) => m.id === catalogId)!;
  return {
    ...catalog,
    id: measureId ?? catalogId,
    status: "Draft",
    compileStatus: "NOT_COMPILED",
    spec: OFFICIAL_ONLY_PRE_CHANGE[catalogId as keyof typeof OFFICIAL_ONLY_PRE_CHANGE],
  };
};

const PROMOTED_OFFICIAL_ONLY = ["cms2", "cms130", "cms165"] as const;

async function promoteOfficialOnlyRows(store: MeasureStore, events: CaseEventStore): Promise<void> {
  for (const id of PROMOTED_OFFICIAL_ONLY) {
    const row = await store.getLatest(id);
    if (!row || row.status === "Active") continue;
    if (!matchesSeedFingerprint(row, preChangeCatalog(id))) {
      console.warn(`[measure-seed] ${id} row was edited; not promoted to Active`);
      continue;
    }
    await store.setVersionStatus(id, row.versionId, { status: "Active", activate: true });
    const audit: AppendAuditInput = {
      eventType: "MEASURE_ACTIVATED",
      entityType: "measure_version",
      entityId: row.versionId,
      actor: "system",
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: row.versionId,
      payload: { measureId: id, version: row.version, reason: "official-only measure activated (MM-1b, ADR-072)", activatedBy: "system" },
    };
    if (!(await events.hasAuditEvent(audit))) await events.appendAudit(audit);
  }
}
async function deprecateLegacyOfficialRows(store: MeasureStore, events: CaseEventStore): Promise<void> {
  for (const { legacyId, catalogId } of LEGACY_OFFICIAL_IDS) {
    const row = await store.getLatest(legacyId);
    const reason = `superseded by ${catalogId} (catalog id rename, 2026-09)`;
    if (!row || !(await store.getLatest(catalogId))) continue;
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
      if (matchesSeedFingerprint(row, preChangeCatalog(catalogId, legacyId), "Deprecated") && !(await events.hasAuditEvent(audit))) {
        await events.appendAudit(audit);
      }
      continue;
    }
    if (!matchesSeedFingerprint(row, preChangeCatalog(catalogId, legacyId))) {
      // Left alone on purpose (someone edited it), but say so: the bare row now coexists with it.
      console.warn(`[measure-seed] legacy row ${legacyId} does not match the seed fingerprint; not deprecated, ${catalogId} coexists with it`);
      continue;
    }
    if (!(await events.hasAuditEvent(audit))) await events.appendAudit(audit);
    await store.setVersionStatus(legacyId, row.versionId, { status: "Deprecated" });
  }
}

async function repairHypertensionSeedRow(
  store: MeasureStore,
  cqlOf: (measureId: string) => string,
  events: CaseEventStore,
): Promise<void> {
  const measureId = "hypertension";
  const row = await store.getLatest(measureId);
  if (!row) return;
  const catalog = MEASURE_CATALOG.find((m) => m.id === measureId)!;
  const fieldState = (value: unknown, oldValue: unknown, newValue: unknown): "old" | "new" | "edited" =>
    deepEqual(value, oldValue) ? "old" : deepEqual(value, newValue) ? "new" : "edited";
  const policyState = fieldState(row.policyRef, HYPERTENSION_PRE_CHANGE.policyRef, catalog.policyRef);
  const specState = fieldState(row.spec, HYPERTENSION_PRE_CHANGE.spec, catalog.spec);
  // The CQL is fingerprinted too (by normalized text rather than deepEqual): only the text the seed
  // itself wrote (the pre-change or the current reconstruction) is ever replaced. Anything else was authored in Studio and is kept — a
  // CQL-only edit is as much someone's work as a spec edit. Line endings and trailing whitespace are
  // normalized because the stored text may have crossed a CRLF boundary or been re-saved from an
  // editor that terminates the buffer with a newline; neither can turn authored text into the seed's.
  const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
  const currentCql = cqlOf(measureId);
  const cqlState = fieldState(norm(row.cqlText), norm(HYPERTENSION_PRE_CHANGE_CQL), norm(currentCql));
  if (policyState === "edited" || specState === "edited" || cqlState === "edited") {
    console.warn(
      `[measure-seed] hypertension row does not match the pre-change seed fingerprint ` +
        `(policyRef=${policyState}, spec=${specState}, cqlText=${cqlState}); not updated`,
    );
    return;
  }
  if (policyState === "new" && specState === "new" && cqlState === "new") return;
  const audit: AppendAuditInput = {
    eventType: "MEASURE_SEED_UPDATED",
    entityType: "measure_version",
    entityId: row.versionId,
    actor: "system",
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: row.versionId,
    payload: { measureId, fields: ["policyRef", "spec", "cqlText"] },
  };
  if (!(await events.hasAuditEvent(audit))) await events.appendAudit(audit);
  await store.updateSpec(measureId, catalog.spec, catalog.policyRef);
  await store.updateCql(measureId, currentCql);
}

/**
 * Seeds the measure store from MEASURE_CATALOG. On a fresh (empty) store every catalog entry
 * is inserted. On an already-seeded store (e.g. the live stack) only catalog measures that are
 * MISSING from the store are inserted — existing rows are never overwritten, preserving any
 * create/lifecycle edits made since the initial seed (idempotent back-fill, #76).
 * `cqlOf` reconstructs CQL text for runnable measures.
 */
export async function seedMeasureStore(store: MeasureStore, cqlOf: (measureId: string) => string, events: CaseEventStore): Promise<void> {
  await repairHypertensionSeedRow(store, cqlOf, events);
  const empty = await store.isEmpty();
  for (const m of MEASURE_CATALOG) {
    // Fast path on a fresh store: seed everything. On an already-seeded store, back-fill ONLY
    // catalog measures missing from the store (e.g. adult_immunization, added after the initial
    // seed — #76). Never overwrite an existing row: create/lifecycle edits are the source of truth.
    if (!empty && (await store.getLatest(m.id)) !== null) continue;
    if (!empty) {
      // Existing-store catalog back-fills are audited; fresh boot intentionally keeps its historical
      // no-audit path for the full 63-row seed.
      const audit: AppendAuditInput = {
        eventType: "MEASURE_CREATED",
        entityType: "measure_version",
        entityId: `${m.id}-${m.version}`,
        actor: "system",
        refRunId: null,
        refCaseId: null,
        refMeasureVersionId: `${m.id}-${m.version}`,
        payload: { measureId: m.id, version: m.version, reason: "catalog back-fill" },
      };
      if (!(await events.hasAuditEvent(audit))) await events.appendAudit(audit);
    }
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

  await deprecateLegacyOfficialRows(store, events);
  await promoteOfficialOnlyRows(store, events);

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
