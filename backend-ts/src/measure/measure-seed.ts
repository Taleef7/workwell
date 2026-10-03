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
  // ADR-071 applied to the sixth ACO measure (ADR-074): the vendored manifest's id is `cms137`.
  { legacyId: "cms137v14", catalogId: "cms137" },
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
export const OFFICIAL_ONLY_PRE_CHANGE: Record<"cms2" | "cms130" | "cms165" | "cms137", MeasureSpec> = {
  cms137: {
    description: "CMS137v14 (MIPS Quality ID 305) — CMS eCQM 2026 performance period catalog entry. CQL authoring pending.",
    eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
    exclusions: [],
    complianceWindow: "Annual",
    requiredDataElements: [],
    testFixtures: [],
  },
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
    row.createdAt === TIER[catalog.status] &&
    // `updatedAt` was dropped when this generalised isUnmodifiedLegacySeed, and it is the one check
    // `status` does not subsume: a spec that was edited and then restored to exactly the seeded bytes
    // matches on every other field, so without this it fingerprints as untouched and is silently
    // deprecated or promoted as though nobody had ever touched it.
    //
    // `approvedBy`/`activatedAt` are deliberately NOT restored: the original only ever ran against
    // Draft/legacy rows, and a freshly seeded ACTIVE row legitimately carries an activatedAt, so
    // reinstating them here would make every Active catalog row fail its own fingerprint. The `status`
    // equality above covers what they were guarding — an approved row reads Approved, an activated one
    // reads Active.
    (expectedStatus === "Deprecated" || row.updatedAt === TIER[catalog.status])
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
    // Bring the CONTENT forward too, not just the status. `seedMeasureStore` skips rows that already
    // exist, so on any store seeded before this change (TWH, Maui — every live deployment) a
    // status-only promotion leaves an ACTIVE measure still carrying the placeholder Draft spec
    // ("CQL authoring pending", empty eligibility and exclusions) and compileStatus NOT_COMPILED. A
    // pilot user opening /measures/cms2 would read that its logic had not been authored, on a measure
    // the deployment is telling them is live. The route tests missed it because they seed a FRESH
    // store, where the row is created from the current catalog and never goes through this path.
    const catalog = MEASURE_CATALOG.find((m) => m.id === id)!;
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
    // AUDIT BEFORE STATE, the same ordering `repairHypertensionSeedRow` uses and for the same reason.
    // Written after the mutations, a failing append would leave the row Active with no
    // MEASURE_ACTIVATED event — and the guard above (`status === "Active"` ⇒ continue) would skip it
    // on every subsequent boot, so the event is never retried and the ledger is permanently short one
    // activation. "Every state change writes audit_event — no exceptions" (CLAUDE.md) means the audit
    // cannot be the step that is allowed to be lost.
    //
    // Ordered this way the failure is recoverable in the safe direction: an append that succeeds and a
    // mutation that then fails leaves the row Draft, so the next boot retries the promotion, and
    // `hasAuditEvent` keeps that retry from writing a second event.
    if (!(await events.hasAuditEvent(audit))) await events.appendAudit(audit);
    // Bring the CONTENT forward too, not just the status. `seedMeasureStore` skips rows that already
    // exist, so on any store seeded before this change (TWH, Maui — every live deployment) a
    // status-only promotion leaves an ACTIVE measure still carrying the placeholder Draft spec
    // ("CQL authoring pending", empty eligibility and exclusions) and compileStatus NOT_COMPILED. A
    // pilot user opening /measures/cms2 would read that its logic had not been authored, on a measure
    // the deployment is telling them is live. The route tests missed it because they seed a FRESH
    // store, where the row is created from the current catalog and never goes through this path.
    await store.updateSpec(id, catalog.spec, catalog.policyRef);
    if (row.compileStatus !== catalog.compileStatus) {
      await store.updateCql(id, row.cqlText ?? "", catalog.compileStatus);
    }
    await store.setVersionStatus(id, row.versionId, { status: "Active", activate: true });
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

/**
 * #749: before the fix every authored "most recent" define sorted by `(… as FHIR.dateTime)` with no
 * `.value`, a key the engine cannot order. Runs use the compiled ELM, but the stored `cqlText` is what
 * the MAT export, the audit packet and the MCP tools hand out, so a stack seeded before the fix kept
 * the old sort there. `pre749Cql` reconstructs the text the seed wrote then from today's text.
 */
const PRE_749_SORT = /(sort by \((?:performed|occurrence|effective) as FHIR\.dateTime\))\.value/g;

export function pre749Cql(current: string): string | null {
  const old = current.replace(PRE_749_SORT, "$1");
  return old === current ? null : old;
}

const normCql = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

/**
 * Rewrites a row's CQL to today's text only where it is exactly what the seed wrote before #749; a
 * text anyone edited is left alone. Audit-first and audited on EVERY rewrite, under its own event type.
 * No `hasAuditEvent` guard: it keys on (event, version) only, so it cannot tell a retry of a failed write
 * from a later rewrite (a Studio save of the exact pre-#749 text, rewritten again), and guarding would
 * make that second rewrite silent. A failed write retried is therefore recorded twice — the ledger errs
 * toward an over-claim, never a silent change (DATA_MODEL_CONTRACTS §4).
 */
async function repairPre749SortCql(
  store: MeasureStore,
  cqlOf: (measureId: string) => string,
  events: CaseEventStore,
): Promise<void> {
  for (const m of MEASURE_CATALOG) {
    const current = cqlOf(m.id);
    const old = current ? pre749Cql(current) : null;
    if (!old) continue;
    const row = await store.getLatest(m.id);
    if (!row || normCql(row.cqlText) !== normCql(old)) continue;
    const audit: AppendAuditInput = {
      eventType: "MEASURE_SEED_CQL_REFRESHED",
      entityType: "measure_version",
      entityId: row.versionId,
      actor: "system",
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: row.versionId,
      payload: { measureId: m.id, fields: ["cqlText"], reason: "most-recent sort (#749)" },
    };
    await events.appendAudit(audit);
    await store.updateCql(m.id, current);
  }
}

/**
 * The six routed measures' descriptions exactly as the seed wrote them before they said which logic
 * runs. They put the QDM measure (`CMS2v15`) in the title, and the four official-only ones called the
 * artifact "published", over counts produced by CMS's FHIR draft (`CMS2FHIR v1.0.000`), which locked
 * decision §4.3 forbids.
 */
export const PRE_DRAFT_WORDING_DESCRIPTIONS: Readonly<Record<"cms2" | "cms130" | "cms165" | "cms137" | "cms122" | "cms125", string>> = {
  cms2: "Screening for Depression and Follow-Up Plan (CMS2v15 / MIPS 134): patients 12+ screened for depression with an age-appropriate standardized tool during the measurement period and, if positive, with a follow-up plan documented on the date of the positive screen. Evaluated by CMS's published QI-Core artifact (2026 FHIR content) over the calendar measurement period.",
  cms137: "Initiation and Engagement of Substance Use Disorder Treatment (CMS137v14 / MIPS 305): patients 13+ with a new substance use disorder episode between January 1 and November 14 of the measurement period and no diagnosis or treatment in the 60 days before it. TWO RATES over one denominator (ADR-074): Initiation — treatment (a visit, a psychosocial service, or a medication order) within 14 days of the episode; Engagement — two or more further services within 34 days of initiation, or a long-acting medication. Evaluated by CMS's published QI-Core artifact (2026 FHIR content) over the calendar measurement period; a patient is COMPLIANT only where every rate they are in is met.",
  cms165: "Controlling High Blood Pressure (CMS165v14 / MIPS 236): adults 18-85 at the end of the measurement period with essential hypertension whose most recent BP reading during the measurement period is adequately controlled. Evaluated by CMS's published QI-Core artifact (2026 FHIR content) over the calendar measurement period.",
  cms122: "Diabetes: HbA1c Poor Control (CMS122v14 / MIPS 1): patients 18–75 with diabetes whose most recent HbA1c result is > 9% (poor control). OVERDUE indicates intervention is needed.",
  cms125: "Breast Cancer Screening (CMS125v14 / MIPS 112): women 42–74 who had a mammogram in the measurement period or 26 months prior.",
  cms130: "Colorectal Cancer Screening (CMS130v14 / MIPS 113): adults 50-75 at the end of the measurement period screened for colorectal cancer by colonoscopy, sigmoidoscopy, CT colonography, sDNA-FIT, or FOBT. Evaluated by CMS's published QI-Core artifact (2026 FHIR content) over the calendar measurement period.",
};

/**
 * Rewrites a routed measure's spec to today's catalog wording only where the stored spec is exactly
 * the catalog spec with the old description, so every live stack stops calling a draft "published"
 * while a spec anyone edited is left alone. `seedMeasureStore` never overwrites an existing row, so
 * without this only a fresh database would read the new wording.
 *
 * The same shape as `repairPre749SortCql`, for the same reasons: audit-first, under its own event type,
 * on EVERY rewrite with no `hasAuditEvent` guard (a guard keyed on event and version cannot tell a
 * retried write from a later rewrite, and would make the second one silent). A retried write is
 * therefore recorded twice: an over-claim, never a silent change (DATA_MODEL_CONTRACTS §4).
 */
async function repairPreDraftWordingSpecs(store: MeasureStore, events: CaseEventStore): Promise<void> {
  for (const [measureId, oldDescription] of Object.entries(PRE_DRAFT_WORDING_DESCRIPTIONS)) {
    const catalog = MEASURE_CATALOG.find((m) => m.id === measureId);
    if (!catalog) continue;
    const row = await store.getLatest(measureId);
    if (!row || !deepEqual(row.spec, { ...catalog.spec, description: oldDescription })) continue;
    const audit: AppendAuditInput = {
      eventType: "MEASURE_SEED_SPEC_REFRESHED",
      entityType: "measure_version",
      entityId: row.versionId,
      actor: "system",
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: row.versionId,
      payload: { measureId, fields: ["spec.description"], reason: "names the CMS FHIR draft that runs, not a published artifact" },
    };
    await events.appendAudit(audit);
    await store.updateSpec(measureId, catalog.spec);
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
  // First, so a hypertension row the seed wrote before #749 reads as current to the repair below.
  await repairPre749SortCql(store, cqlOf, events);
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
  // After promotion: a row promoted on this boot already carries today's wording, so this touches only
  // rows seeded or promoted while the description still called the artifact "published".
  await repairPreDraftWordingSpecs(store, events);

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
