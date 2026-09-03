/**
 * measure-seed unit tests (#76 E6 — Codex P1).
 *   node --import tsx --test src/measure/measure-seed.test.ts
 *
 * Verifies the idempotent back-fill behaviour of seedMeasureStore:
 *  (a) Fresh store → all MEASURE_CATALOG entries are seeded.
 *  (b) Non-empty store missing adult_immunization → back-fills only that entry.
 *  (c) Re-seed on an already-seeded store never overwrites existing rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteMeasureStore } from "../stores/sqlite/measure-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { MeasureStore } from "../stores/measure-store.ts";
import { MEASURE_CATALOG, type MeasureSpec } from "./measure-catalog.ts";
import { seedMeasureStore } from "./measure-seed.ts";
import { HYPERTENSION_PRE_CHANGE_CQL } from "./hypertension-pre-change-cql.ts";

const created: string[] = [];

async function freshDb() {
  const dbPath = join(tmpdir(), `workwell-seed-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return db;
}

// Clean up temp files after all tests
import { after } from "node:test";
after(() => {
  for (const p of created) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

const LEGACY_ROWS = [
  { legacyId: "cms2v15", catalogId: "cms2" },
  { legacyId: "cms130v14", catalogId: "cms130" },
  { legacyId: "cms165v14", catalogId: "cms165" },
] as const;

async function seedLegacyRow(store: MeasureStore, legacyId: string, catalogId: string, edited = false): Promise<void> {
  const catalog = MEASURE_CATALOG.find((m) => m.id === catalogId)!;
  await store.seedMeasure({
    measureId: legacyId,
    name: catalog.name,
    policyRef: catalog.policyRef,
    owner: catalog.owner,
    tags: [...catalog.tags],
    versionId: `${legacyId}-${catalog.version}`,
    version: catalog.version,
    status: "Draft",
    spec: edited ? { ...catalog.spec, description: `${catalog.spec.description} (edited)` } : catalog.spec,
    cqlText: "",
    compileStatus: catalog.compileStatus,
    createdAt: "2026-02-01T00:00:00.000Z",
    changeSummary: "Seeded measure version",
  });
}

async function seedCatalogExcept(store: MeasureStore, omittedId: string): Promise<void> {
  const TIER: Record<string, string> = {
    Active: "2026-06-10T00:00:00.000Z",
    Approved: "2026-04-01T00:00:00.000Z",
    Draft: "2026-02-01T00:00:00.000Z",
    Deprecated: "2025-06-01T00:00:00.000Z",
  };
  for (const m of MEASURE_CATALOG) {
    if (m.id === omittedId) continue;
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
      cqlText: "",
      compileStatus: m.compileStatus,
      createdAt: TIER[m.status]!,
      changeSummary: "Seeded measure version",
    });
  }
}

// ---------------------------------------------------------------------------
// Test A1: Fresh store seeds all catalog entries
// ---------------------------------------------------------------------------
test("seedMeasureStore — fresh store seeds all MEASURE_CATALOG entries", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  await seedMeasureStore(store, () => "", new SqliteCaseEventStore(db));

  const all = await store.listLatest();
  assert.equal(
    all.length,
    MEASURE_CATALOG.length,
    `expected ${MEASURE_CATALOG.length} measures after fresh seed, got ${all.length}`,
  );

  const immunization = await store.getLatest("adult_immunization");
  assert.ok(immunization !== null, "adult_immunization must be present after fresh seed");
  assert.equal(immunization!.measureId, "adult_immunization");
});

// ---------------------------------------------------------------------------
// Test A2: Back-fills a missing measure on a non-empty store
// ---------------------------------------------------------------------------
test("seedMeasureStore — back-fills adult_immunization when it is absent from a non-empty store", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);

  // Manually seed every catalog entry EXCEPT adult_immunization
  const TIER: Record<string, string> = {
    Active: "2026-06-10T00:00:00.000Z",
    Approved: "2026-04-01T00:00:00.000Z",
    Draft: "2026-02-01T00:00:00.000Z",
    Deprecated: "2025-06-01T00:00:00.000Z",
  };
  for (const m of MEASURE_CATALOG) {
    if (m.id === "adult_immunization") continue;
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
      cqlText: "",
      compileStatus: m.compileStatus,
      createdAt: TIER[m.status] ?? "2026-02-01T00:00:00.000Z",
      changeSummary: "Seeded measure version",
    });
  }

  // Precondition: store is non-empty and adult_immunization is missing
  const beforeAll = await store.listLatest();
  assert.equal(beforeAll.length, MEASURE_CATALOG.length - 1, "store should have all entries except adult_immunization");
  assert.equal(await store.getLatest("adult_immunization"), null, "adult_immunization must be absent before back-fill");

  // Run the seeder — should back-fill only adult_immunization
  await seedMeasureStore(store, () => "", events);

  const immunization = await store.getLatest("adult_immunization");
  assert.ok(immunization !== null, "adult_immunization must be present after back-fill");
  assert.equal(immunization!.measureId, "adult_immunization");

  const afterAll = await store.listLatest();
  assert.equal(
    afterAll.length,
    MEASURE_CATALOG.length,
    `expected exactly ${MEASURE_CATALOG.length} entries after back-fill (no duplicates)`,
  );
});

// ---------------------------------------------------------------------------
// Test A3: Re-seed never overwrites an existing row
// ---------------------------------------------------------------------------
test("seedMeasureStore — re-seed does not overwrite existing rows", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);

  // First seed
  await seedMeasureStore(store, () => "", events);

  const beforeCount = (await store.listLatest()).length;
  assert.equal(beforeCount, MEASURE_CATALOG.length, "sanity: all entries present after first seed");

  // Mutate audiogram's spec
  const editedSpec = {
    description: "EDITED BY TEST — must survive re-seed",
    eligibilityCriteria: { roleFilter: "Welder", siteFilter: "Plant A", programEnrollmentText: "HCP" },
    exclusions: [{ label: "Waiver", criteriaText: "on file" }],
    complianceWindow: "Annual",
    requiredDataElements: ["Last exam"],
    testFixtures: [],
  };
  await store.updateSpec("audiogram", editedSpec, "OSHA 29 CFR 1910.95 — edited");

  const afterMutate = await store.getLatest("audiogram");
  assert.equal(afterMutate?.spec.description, "EDITED BY TEST — must survive re-seed", "mutation must be in place");

  // Second seed — must not overwrite
  await seedMeasureStore(store, () => "", events);

  const afterReseed = await store.getLatest("audiogram");
  assert.equal(
    afterReseed?.spec.description,
    "EDITED BY TEST — must survive re-seed",
    "re-seed must not clobber the edited spec",
  );

  const afterCount = (await store.listLatest()).length;
  assert.equal(afterCount, MEASURE_CATALOG.length, "no duplicate rows after re-seed");
});

// ---------------------------------------------------------------------------
// Test A4: Promotes a pre-existing Approved hepatitis_b_vaccination_series (E10.6)
// ---------------------------------------------------------------------------
test("seedMeasureStore — promotes a pre-existing Approved Hep B row to Active + CQL (idempotent)", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  const TIER: Record<string, string> = {
    Active: "2026-06-10T00:00:00.000Z",
    Approved: "2026-04-01T00:00:00.000Z",
    Draft: "2026-02-01T00:00:00.000Z",
    Deprecated: "2025-06-01T00:00:00.000Z",
  };
  const HEPB = "hepatitis_b_vaccination_series";
  const cqlOf = (id: string) => (id === HEPB ? "library HepatitisBSeries version '1.0.0'" : "");

  // Simulate a store seeded BEFORE the promotion: every catalog entry present, but Hep B as the old
  // Approved, catalog-only row (no CQL) — its current catalog status is Active.
  for (const m of MEASURE_CATALOG) {
    const pre = m.id === HEPB;
    await store.seedMeasure({
      measureId: m.id,
      name: m.name,
      policyRef: m.policyRef,
      owner: m.owner,
      tags: [...m.tags],
      versionId: `${m.id}-${m.version}`,
      version: m.version,
      status: pre ? "Approved" : m.status,
      spec: m.spec,
      cqlText: "",
      compileStatus: pre ? "NOT_COMPILED" : m.compileStatus,
      createdAt: TIER[pre ? "Approved" : m.status] ?? "2026-02-01T00:00:00.000Z",
      changeSummary: "Seeded measure version",
    });
  }
  assert.equal((await store.getLatest(HEPB))?.status, "Approved", "Hep B starts as the pre-promotion Approved row");

  // Run the seeder with real CQL for Hep B → must promote it to Active + back-fill CQL.
  await seedMeasureStore(store, cqlOf, events);
  const after = await store.getLatest(HEPB);
  assert.equal(after?.status, "Active", "Hep B must be promoted to Active");
  assert.ok(after?.cqlText.includes("HepatitisBSeries"), "Hep B must have its CQL back-filled");

  // Idempotent: a second run leaves it Active and creates no duplicate rows.
  await seedMeasureStore(store, cqlOf, events);
  assert.equal((await store.getLatest(HEPB))?.status, "Active", "Hep B stays Active on re-seed (idempotent)");
  assert.equal((await store.listLatest()).length, MEASURE_CATALOG.length, "no duplicate rows after promotion backfill");
});

// ---------------------------------------------------------------------------
// Test A5: Does NOT clobber a user lifecycle edit to Hep B (e.g. Deprecated)
// ---------------------------------------------------------------------------
test("seedMeasureStore — promotion backfill leaves a non-Approved Hep B row untouched", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  await seedMeasureStore(store, () => "", events); // fresh seed: Hep B already Active (catalog status)

  // A user deprecates Hep B after the promotion.
  const hepb = await store.getLatest("hepatitis_b_vaccination_series");
  await store.setVersionStatus("hepatitis_b_vaccination_series", hepb!.versionId, { status: "Deprecated" });
  assert.equal((await store.getLatest("hepatitis_b_vaccination_series"))?.status, "Deprecated");

  // Re-seed must NOT re-promote it (gate is on the original "Approved" state only).
  await seedMeasureStore(store, () => "", events);
  assert.equal(
    (await store.getLatest("hepatitis_b_vaccination_series"))?.status,
    "Deprecated",
    "a deliberate Deprecated edit must survive re-seed (backfill only promotes the original Approved row)",
  );
});

test("seedMeasureStore — deprecates a legacy cms2v15 row once and audits it once", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  await store.seedMeasure({
    measureId: "cms2v15",
    name: "Preventive Care and Screening: Screening for Depression and Follow-Up Plan",
    policyRef: "CMS2v15",
    owner: "WorkWell Studio",
    tags: ["ecqm", "cms", "mental-health", "preventive"],
    versionId: "cms2v15-v1.0",
    version: "v1.0",
    status: "Draft",
    spec: {
      description: "CMS2v15 (MIPS Quality ID 134) — CMS eCQM 2026 performance period catalog entry. CQL authoring pending.",
      eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
      exclusions: [],
      complianceWindow: "Annual",
      requiredDataElements: [],
      testFixtures: [],
    },
    cqlText: "",
    compileStatus: "NOT_COMPILED",
    createdAt: "2026-02-01T00:00:00.000Z",
    changeSummary: "Seeded measure version",
  });

  await seedMeasureStore(store, () => "", events);
  assert.equal((await store.getLatest("cms2v15"))?.status, "Deprecated");
  const firstAuditRows = (await db.prepare(
    "SELECT event_type, entity_type, entity_id, ref_measure_version_id, payload_json FROM audit_events WHERE entity_id = ? AND ref_measure_version_id = ?",
  ).bind("cms2v15-v1.0", "cms2v15-v1.0").all<{ event_type: string; entity_type: string; entity_id: string; ref_measure_version_id: string; payload_json: string }>()).results ?? [];
  assert.equal(firstAuditRows.length, 1);
  assert.equal(firstAuditRows[0]!.event_type, "MEASURE_DEPRECATED");
  assert.equal(firstAuditRows[0]!.entity_type, "measure_version");
  assert.equal(firstAuditRows[0]!.entity_id, "cms2v15-v1.0");
  assert.equal(firstAuditRows[0]!.ref_measure_version_id, "cms2v15-v1.0");
  assert.equal(
    (JSON.parse(firstAuditRows[0]!.payload_json) as { reason: string }).reason,
    "superseded by cms2 (catalog id rename, 2026-09)",
  );

  await seedMeasureStore(store, () => "", events);
  assert.equal((await store.getLatest("cms2v15"))?.status, "Deprecated");
  const secondAuditRows = (await db.prepare("SELECT event_type FROM audit_events WHERE entity_id = ? AND ref_measure_version_id = ?").bind("cms2v15-v1.0", "cms2v15-v1.0").all<{ event_type: string }>()).results ?? [];
  assert.equal(secondAuditRows.length, 1, "the second seed must not append another deprecation audit");
});

test("seedMeasureStore — audits before state and retries a failed status write without duplicating", async () => {
  const db = await freshDb();
  const realStore = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  await seedLegacyRow(realStore, "cms2v15", "cms2");

  const setVersionStatus = realStore.setVersionStatus.bind(realStore);
  let failStatusOnce = true;
  realStore.setVersionStatus = async (measureId, versionId, change) => {
    if (failStatusOnce && measureId === "cms2v15") {
      failStatusOnce = false;
      throw new Error("transient status failure");
    }
    return setVersionStatus(measureId, versionId, change);
  };

  await assert.rejects(() => seedMeasureStore(realStore, () => "", events), /transient status failure/);
  assert.equal((await realStore.getLatest("cms2v15"))?.status, "Draft");
  const afterAudit = await db
    .prepare("SELECT event_type FROM audit_events WHERE entity_id = ? AND ref_measure_version_id = ?")
    .bind("cms2v15-v1.0", "cms2v15-v1.0")
    .all<{ event_type: string }>();
  assert.deepEqual(((afterAudit.results ?? []) as Array<{ event_type: string }>).map((row) => row.event_type), ["MEASURE_DEPRECATED"]);

  await seedMeasureStore(realStore, () => "", events);
  assert.equal((await realStore.getLatest("cms2v15"))?.status, "Deprecated");
  const finalAudit = await db
    .prepare("SELECT event_type FROM audit_events WHERE entity_id = ? AND ref_measure_version_id = ?")
    .bind("cms2v15-v1.0", "cms2v15-v1.0")
    .all<{ event_type: string }>();
  assert.deepEqual(((finalAudit.results ?? []) as Array<{ event_type: string }>).map((row) => row.event_type), ["MEASURE_DEPRECATED"]);
});

test("seedMeasureStore — deprecates all three untouched legacy official rows exactly once", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  for (const { legacyId, catalogId } of LEGACY_ROWS) await seedLegacyRow(store, legacyId, catalogId);

  await seedMeasureStore(store, () => "", events);
  for (const { legacyId } of LEGACY_ROWS) {
    assert.equal((await store.getLatest(legacyId))?.status, "Deprecated");
    const rows = await db
      .prepare("SELECT event_type FROM audit_events WHERE entity_id = ? AND ref_measure_version_id = ?")
      .bind(`${legacyId}-v1.0`, `${legacyId}-v1.0`)
      .all<{ event_type: string }>();
    assert.deepEqual(((rows.results ?? []) as Array<{ event_type: string }>).map((row) => row.event_type), ["MEASURE_DEPRECATED"], legacyId);
  }

  await seedMeasureStore(store, () => "", events);
  for (const { legacyId } of LEGACY_ROWS) {
    const rows = await db
      .prepare("SELECT event_type FROM audit_events WHERE entity_id = ? AND ref_measure_version_id = ?")
      .bind(`${legacyId}-v1.0`, `${legacyId}-v1.0`)
      .all<{ event_type: string }>();
    assert.equal((rows.results ?? []).length, 1, `${legacyId} must remain exactly-once`);
  }
});

test("seedMeasureStore — leaves an edited legacy row Draft with no deprecation event", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  await seedLegacyRow(store, "cms2v15", "cms2", true);

  await seedMeasureStore(store, () => "", events);
  assert.equal((await store.getLatest("cms2v15"))?.status, "Draft");
  const rows = await db
    .prepare("SELECT event_type FROM audit_events WHERE entity_id = ? AND ref_measure_version_id = ?")
    .bind("cms2v15-v1.0", "cms2v15-v1.0")
    .all<{ event_type: string }>();
  assert.deepEqual(rows.results ?? [], []);
});

test("seedMeasureStore — does not deprecate a legacy row when successor insertion fails", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  await seedLegacyRow(store, "cms2v15", "cms2");

  const seedMeasure = store.seedMeasure.bind(store);
  store.seedMeasure = async (input) => {
    if (input.measureId === "cms2") throw new Error("successor insertion failure");
    return seedMeasure(input);
  };

  await assert.rejects(() => seedMeasureStore(store, () => "", events), /successor insertion failure/);
  assert.equal((await store.getLatest("cms2v15"))?.status, "Draft");
});

test("seedMeasureStore — audits one catalog back-fill and none on fresh boot", async () => {
  const existingDb = await freshDb();
  const existingStore = new SqliteMeasureStore(existingDb);
  const existingEvents = new SqliteCaseEventStore(existingDb);
  await seedCatalogExcept(existingStore, "cms2");

  await seedMeasureStore(existingStore, () => "", existingEvents);
  const backfillRows = await existingDb
    .prepare("SELECT event_type, entity_type, entity_id, actor, payload_json FROM audit_events WHERE entity_id = ?")
    .bind("cms2-v1.0")
    .all<{ event_type: string; entity_type: string; entity_id: string; actor: string; payload_json: string }>();
  assert.equal((backfillRows.results ?? []).length, 1);
  assert.deepEqual(backfillRows.results?.[0], {
    event_type: "MEASURE_CREATED",
    entity_type: "measure_version",
    entity_id: "cms2-v1.0",
    actor: "system",
    payload_json: JSON.stringify({ measureId: "cms2", version: "v1.0", reason: "catalog back-fill" }),
  });

  const freshDbInstance = await freshDb();
  const freshStore = new SqliteMeasureStore(freshDbInstance);
  await seedMeasureStore(freshStore, () => "", new SqliteCaseEventStore(freshDbInstance));
  const freshAudits = await freshDbInstance.prepare("SELECT event_type FROM audit_events").all<{ event_type: string }>();
  assert.deepEqual(freshAudits.results ?? [], [], "fresh 63-row seed keeps its existing no-audit path");
});

test("seedMeasureStore — deprecates an untouched legacy row when persisted spec keys are reordered", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  const catalog = MEASURE_CATALOG.find((m) => m.id === "cms2")!;
  const persistedSpec = {
    testFixtures: catalog.spec.testFixtures,
    requiredDataElements: catalog.spec.requiredDataElements,
    complianceWindow: catalog.spec.complianceWindow,
    exclusions: catalog.spec.exclusions,
    eligibilityCriteria: catalog.spec.eligibilityCriteria,
    description: catalog.spec.description,
  };
  assert.notEqual(JSON.stringify(persistedSpec), JSON.stringify(catalog.spec), "test must reorder persisted spec keys");

  await store.seedMeasure({
    measureId: "cms2v15",
    name: catalog.name,
    policyRef: catalog.policyRef,
    owner: catalog.owner,
    tags: [...catalog.tags],
    versionId: "cms2v15-v1.0",
    version: catalog.version,
    status: catalog.status,
    spec: persistedSpec,
    cqlText: "",
    compileStatus: catalog.compileStatus,
    createdAt: "2026-02-01T00:00:00.000Z",
    changeSummary: "Seeded measure version",
  });

  await seedMeasureStore(store, () => "", events);
  assert.equal((await store.getLatest("cms2v15"))?.status, "Deprecated");
});

test("seedMeasureStore — a failed catalog back-fill audit is retried without duplication, and the legacy row is then deprecated", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const realEvents = new SqliteCaseEventStore(db);
  let failFirstAudit = true;
  const events = {
    appendAudit: async (input: Parameters<CaseEventStore["appendAudit"]>[0]) => {
      if (failFirstAudit) {
        failFirstAudit = false;
        throw new Error("transient audit failure");
      }
      await realEvents.appendAudit(input);
    },
    hasAuditEvent: (input: { eventType: string; entityId: string | null; refMeasureVersionId: string | null }) =>
      db
        .prepare(
          "SELECT 1 FROM audit_events WHERE event_type = ? AND entity_id = ? AND ref_measure_version_id = ? LIMIT 1",
        )
        .bind(input.eventType, input.entityId, input.refMeasureVersionId)
        .first<{ one: number }>()
        .then((row: { one: number } | null) => row !== null),
  } as unknown as CaseEventStore;
  const catalog = MEASURE_CATALOG.find((m) => m.id === "cms2")!;

  await store.seedMeasure({
    measureId: "cms2v15",
    name: catalog.name,
    policyRef: catalog.policyRef,
    owner: catalog.owner,
    tags: [...catalog.tags],
    versionId: "cms2v15-v1.0",
    version: catalog.version,
    status: catalog.status,
    spec: catalog.spec,
    cqlText: "",
    compileStatus: catalog.compileStatus,
    createdAt: "2026-02-01T00:00:00.000Z",
    changeSummary: "Seeded measure version",
  });

  await assert.rejects(() => seedMeasureStore(store, () => "", events), /transient audit failure/);
  assert.equal((await store.getLatest("cms2v15"))?.status, "Draft");

  await seedMeasureStore(store, () => "", events);
  const auditRows = await db
    .prepare("SELECT event_type FROM audit_events WHERE entity_id = ? AND ref_measure_version_id = ?")
    .bind("cms2v15-v1.0", "cms2v15-v1.0")
    .all<{ event_type: string }>();
  assert.deepEqual(
    ((auditRows.results ?? []) as Array<{ event_type: string }>).map((row) => row.event_type),
    ["MEASURE_DEPRECATED"],
    "retry must repair the missing event without duplicating it",
  );
});

test("seedMeasureStore — repairs a legacy row already Deprecated but missing its audit event (crash between audit and state, or a pre-PR deprecation)", async () => {
  // Exercises the `row.status === "Deprecated"` repair branch in deprecateLegacyOfficialRows, which
  // the retry test above never reaches (its first failure is the catalog back-fill audit).
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  const catalog = MEASURE_CATALOG.find((m) => m.id === "cms2")!;

  await store.seedMeasure({
    measureId: "cms2v15",
    name: catalog.name,
    policyRef: catalog.policyRef,
    owner: catalog.owner,
    tags: [...catalog.tags],
    versionId: "cms2v15-v1.0",
    version: catalog.version,
    status: "Deprecated",
    spec: catalog.spec,
    cqlText: "",
    compileStatus: catalog.compileStatus,
    createdAt: "2026-02-01T00:00:00.000Z",
    changeSummary: "Seeded measure version",
  });

  const countDeprecated = async () => {
    const rows = await db
      .prepare("SELECT event_type FROM audit_events WHERE event_type = 'MEASURE_DEPRECATED' AND entity_id = ?")
      .bind("cms2v15-v1.0")
      .all<{ event_type: string }>();
    return (rows.results ?? []).length;
  };
  assert.equal(await countDeprecated(), 0, "precondition: the deprecation is unaudited");

  await seedMeasureStore(store, () => "", events);
  assert.equal((await store.getLatest("cms2v15"))?.status, "Deprecated", "status is untouched");
  assert.equal(await countDeprecated(), 1, "the repair writes the missing MEASURE_DEPRECATED event");

  await seedMeasureStore(store, () => "", events);
  assert.equal(await countDeprecated(), 1, "a second seed does not duplicate it");
});

const HYPERTENSION_PRE_CHANGE: { policyRef: string; spec: MeasureSpec } = {
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

async function seedOldHypertensionRow(
  store: MeasureStore,
  options: { edited?: boolean; halfApplied?: boolean; staleCqlOnly?: boolean; status?: string; cqlText?: string } = {},
): Promise<void> {
  const catalog = MEASURE_CATALOG.find((m) => m.id === "hypertension")!;
  await store.seedMeasure({
    measureId: "hypertension",
    name: catalog.name,
    policyRef: options.halfApplied || options.staleCqlOnly ? catalog.policyRef : HYPERTENSION_PRE_CHANGE.policyRef,
    owner: catalog.owner,
    tags: ["wellness", "hypertension", "cardiovascular"],
    versionId: `hypertension-${catalog.version}`,
    version: catalog.version,
    status: options.status ?? catalog.status,
    spec: options.edited
      ? { ...HYPERTENSION_PRE_CHANGE.spec, eligibilityCriteria: { ...HYPERTENSION_PRE_CHANGE.spec.eligibilityCriteria, siteFilter: "Edited clinic" } }
      : options.staleCqlOnly
        ? catalog.spec
        : HYPERTENSION_PRE_CHANGE.spec,
    // The seed wrote the pre-change reconstruction into cql_text; that exact text is the fingerprint
    // the repair recognises (a stale-CQL-only row carries it too — only its spec/policy were repaired).
    cqlText: options.cqlText ?? HYPERTENSION_PRE_CHANGE_CQL,
    compileStatus: catalog.compileStatus,
    createdAt: "2026-02-01T00:00:00.000Z",
    changeSummary: "Seeded measure version",
  });
}

const countSeedUpdatedEvents = async (db: Awaited<ReturnType<typeof freshDb>>) => {
  const rows = await db
    .prepare("SELECT event_type FROM audit_events WHERE event_type = 'MEASURE_SEED_UPDATED' AND entity_id = 'hypertension-v1.0'")
    .all<{ event_type: string }>();
  return (rows.results ?? []).length;
};

test("seedMeasureStore — repairs the pre-change hypertension seed row exactly once, refreshes CQL, and stays quiet on the second seed", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  const catalog = MEASURE_CATALOG.find((m) => m.id === "hypertension")!;

  await seedOldHypertensionRow(store, { status: "Approved" });
  assert.equal(await countSeedUpdatedEvents(db), 0, "precondition: no repair event yet");

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    await seedMeasureStore(store, () => 'define "In Eligible Population": true', events);
    await seedMeasureStore(store, () => 'define "In Eligible Population": true', events);
  } finally {
    console.warn = originalWarn;
  }
  const repaired = await store.getLatest("hypertension");
  assert.ok(repaired !== null);
  assert.equal(repaired!.policyRef, catalog.policyRef);
  assert.deepEqual(repaired!.spec, catalog.spec);
  assert.deepEqual(repaired!.tags, ["wellness", "hypertension", "cardiovascular"], "tags are not rewritten");
  assert.equal(repaired!.status, "Approved", "lifecycle status is preserved");
  assert.equal(repaired!.version, catalog.version, "version is preserved");
  assert.match(repaired!.cqlText, /In Eligible Population/);
  assert.equal(await countSeedUpdatedEvents(db), 1);
  assert.equal(await countSeedUpdatedEvents(db), 1, "a second seed does not duplicate the repair");
  assert.deepEqual(warnings, [], "a second seed does not warn");
});

test("seedMeasureStore — repairs a half-applied hypertension row without a second audit", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  const catalog = MEASURE_CATALOG.find((m) => m.id === "hypertension")!;
  await seedOldHypertensionRow(store, { halfApplied: true });

  assert.equal((await store.getLatest("hypertension"))!.policyRef, catalog.policyRef);
  assert.deepEqual((await store.getLatest("hypertension"))!.spec, HYPERTENSION_PRE_CHANGE.spec);
  await seedMeasureStore(store, () => 'define "In Eligible Population": true', events);
  assert.deepEqual((await store.getLatest("hypertension"))!.spec, catalog.spec);
  assert.equal(await countSeedUpdatedEvents(db), 1);
});

test("seedMeasureStore — repairs a CQL-only half-applied row and makes no updates on the second seed", async () => {
  class CountingMeasureStore extends SqliteMeasureStore {
    updateSpecCalls = 0;
    updateCqlCalls = 0;

    override async updateSpec(measureId: string, spec: MeasureSpec, policyRef?: string) {
      this.updateSpecCalls++;
      return super.updateSpec(measureId, spec, policyRef);
    }

    override async updateCql(measureId: string, cqlText: string, compileStatus?: string) {
      this.updateCqlCalls++;
      return super.updateCql(measureId, cqlText, compileStatus);
    }
  }

  const db = await freshDb();
  const store = new CountingMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  const catalog = MEASURE_CATALOG.find((m) => m.id === "hypertension")!;
  await seedOldHypertensionRow(store, { staleCqlOnly: true });

  const cqlOf = (measureId: string) => (measureId === "hypertension" ? 'define "Repaired CQL": true' : "");

  await seedMeasureStore(store, cqlOf, events);
  const repaired = await store.getLatest("hypertension");
  assert.deepEqual(repaired!.spec, catalog.spec);
  assert.equal(repaired!.policyRef, catalog.policyRef);
  assert.equal(repaired!.cqlText, 'define "Repaired CQL": true', "stale CQL is refreshed");
  assert.equal(await countSeedUpdatedEvents(db), 1, "the repair audit is deduplicated");

  const specCallsAfterFirstSeed = store.updateSpecCalls;
  const cqlCallsAfterFirstSeed = store.updateCqlCalls;

  await seedMeasureStore(store, cqlOf, events);
  assert.equal(store.updateSpecCalls, specCallsAfterFirstSeed, "the fully repaired row makes no updateSpec call on the second seed");
  assert.equal(store.updateCqlCalls, cqlCallsAfterFirstSeed, "the fully repaired row makes no updateCql call on the second seed");
  assert.equal(await countSeedUpdatedEvents(db), 1);
});

test("seedMeasureStore — leaves Studio-authored hypertension CQL untouched, whether the spec is pre-change or already repaired", async () => {
  const catalog = MEASURE_CATALOG.find((m) => m.id === "hypertension")!;
  const authored = 'define "In Eligible Population": exists([Observation])  // authored in Studio';
  const cqlOf = () => 'define "In Eligible Population": true';

  // pre-change row; policy already repaired (spec still old); policy AND spec already repaired.
  const shapes = [
    { halfApplied: false, expectPolicy: HYPERTENSION_PRE_CHANGE.policyRef },
    { halfApplied: true, expectPolicy: catalog.policyRef },
    { staleCqlOnly: true, expectPolicy: catalog.policyRef },
  ] as const;
  for (const shape of shapes) {
    const halfApplied = "halfApplied" in shape ? shape.halfApplied : "staleCqlOnly";
    const db = await freshDb();
    const store = new SqliteMeasureStore(db);
    const events = new SqliteCaseEventStore(db);
    await seedOldHypertensionRow(store, { ...shape, cqlText: authored });

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      await seedMeasureStore(store, cqlOf, events);
      await seedMeasureStore(store, cqlOf, events);
    } finally {
      console.warn = originalWarn;
    }
    const stored = (await store.getLatest("hypertension"))!;
    assert.equal(stored.cqlText, authored, `authored CQL survives the seed (shape=${String(halfApplied)})`);
    assert.equal(stored.policyRef, shape.expectPolicy, "the row is left whole, not half-repaired");
    assert.equal(await countSeedUpdatedEvents(db), 0, "no repair event for a row someone edited");
    assert.equal(warnings.length, 2, "each boot says why it left the row alone");
  }
});

test("seedMeasureStore — a CRLF copy, or an editor re-save with a trailing newline, of the pre-change CQL is still recognised as the seed's own text", async () => {
  for (const variant of [HYPERTENSION_PRE_CHANGE_CQL.replace(/\n/g, "\r\n"), `${HYPERTENSION_PRE_CHANGE_CQL}\n`]) {
    const db = await freshDb();
    const store = new SqliteMeasureStore(db);
    const events = new SqliteCaseEventStore(db);
    await seedOldHypertensionRow(store, { cqlText: variant });
    await seedMeasureStore(store, () => 'define "In Eligible Population": true', events);
    assert.match((await store.getLatest("hypertension"))!.cqlText, /In Eligible Population/);
    assert.equal(await countSeedUpdatedEvents(db), 1);
  }
});

test("HYPERTENSION_PRE_CHANGE_CQL is the exact text the pre-change seed stored (provenance digest, not self-referential)", () => {
  // Pinned from `reconstructCql` of the pre-change ELM (`HypertensionBPScreeningCQL-1.0.0.elm.json` at
  // beb8c72d, the last commit before the relabel), computed independently of the constant: 2057 chars.
  // The other tests build the simulated live row FROM the constant, so a typo in it would be
  // self-consistent there; this digest is what ties it to the real stored value.
  const digest = createHash("sha256").update(HYPERTENSION_PRE_CHANGE_CQL, "utf8").digest("hex");
  assert.equal(HYPERTENSION_PRE_CHANGE_CQL.length, 2057);
  assert.equal(digest, "17e133992cf4b59ebe764bff4f34ae0741a22860828b160825e5eac824095d1d");
});

test("seedMeasureStore — the fingerprint warning names which field was edited", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  await seedOldHypertensionRow(store, { cqlText: 'define "Authored": true' });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    await seedMeasureStore(store, () => "", events);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]![0]), /policyRef=old, spec=old, cqlText=edited/);
});

test("seedMeasureStore — leaves an edited hypertension spec untouched with a warning and no audit", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  await seedOldHypertensionRow(store, { edited: true });

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    await seedMeasureStore(store, () => "", events);
  } finally {
    console.warn = originalWarn;
  }
  const stored = await store.getLatest("hypertension");
  assert.ok(stored !== null);
  assert.equal(stored!.policyRef, HYPERTENSION_PRE_CHANGE.policyRef);
  assert.equal(stored!.spec.eligibilityCriteria.siteFilter, "Edited clinic");
  assert.equal(await countSeedUpdatedEvents(db), 0);
  assert.equal(warnings.length, 1);
});

test("seedMeasureStore — fresh database seeds current hypertension values without an event or warning", async () => {
  const db = await freshDb();
  const store = new SqliteMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  const catalog = MEASURE_CATALOG.find((m) => m.id === "hypertension")!;

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    await seedMeasureStore(store, () => "", events);
  } finally {
    console.warn = originalWarn;
  }
  const stored = await store.getLatest("hypertension");
  assert.ok(stored !== null);
  assert.equal(stored!.policyRef, catalog.policyRef);
  assert.deepEqual(stored!.spec, catalog.spec);
  assert.equal(await countSeedUpdatedEvents(db), 0);
  assert.deepEqual(warnings, []);
});

test("seedMeasureStore — audit-before-state leaves one audit row when updateSpec throws, then retries without a duplicate", async () => {
  class ThrowOnceMeasureStore extends SqliteMeasureStore {
    shouldThrow = true;

    override async updateSpec(measureId: string, spec: MeasureSpec, policyRef?: string) {
      if (this.shouldThrow) {
        this.shouldThrow = false;
        throw new Error("updateSpec unavailable");
      }
      return super.updateSpec(measureId, spec, policyRef);
    }
  }

  const db = await freshDb();
  const store = new ThrowOnceMeasureStore(db);
  const events = new SqliteCaseEventStore(db);
  const cql = 'define "In Eligible Population": true';
  await seedOldHypertensionRow(store);

  await assert.rejects(() => seedMeasureStore(store, () => cql, events), /updateSpec unavailable/);
  assert.equal(await countSeedUpdatedEvents(db), 1, "audit is durable before state mutation");
  assert.equal((await store.getLatest("hypertension"))!.policyRef, HYPERTENSION_PRE_CHANGE.policyRef);

  await seedMeasureStore(store, () => cql, events);
  const repaired = await store.getLatest("hypertension");
  assert.deepEqual(repaired!.spec, MEASURE_CATALOG.find((m) => m.id === "hypertension")!.spec);
  assert.match(repaired!.cqlText, /In Eligible Population/);
  assert.equal(await countSeedUpdatedEvents(db), 1, "retry does not duplicate the audit");
});
