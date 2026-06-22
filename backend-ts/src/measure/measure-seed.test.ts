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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteMeasureStore } from "../stores/sqlite/measure-store-sqlite.ts";
import { MEASURE_CATALOG } from "./measure-catalog.ts";
import { seedMeasureStore } from "./measure-seed.ts";

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

// ---------------------------------------------------------------------------
// Test A1: Fresh store seeds all catalog entries
// ---------------------------------------------------------------------------
test("seedMeasureStore — fresh store seeds all MEASURE_CATALOG entries", async () => {
  const store = new SqliteMeasureStore(await freshDb());
  await seedMeasureStore(store, () => "");

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
  const store = new SqliteMeasureStore(await freshDb());

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
  await seedMeasureStore(store, () => "");

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
  const store = new SqliteMeasureStore(await freshDb());

  // First seed
  await seedMeasureStore(store, () => "");

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
  await seedMeasureStore(store, () => "");

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
  const store = new SqliteMeasureStore(await freshDb());
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
  await seedMeasureStore(store, cqlOf);
  const after = await store.getLatest(HEPB);
  assert.equal(after?.status, "Active", "Hep B must be promoted to Active");
  assert.ok(after?.cqlText.includes("HepatitisBSeries"), "Hep B must have its CQL back-filled");

  // Idempotent: a second run leaves it Active and creates no duplicate rows.
  await seedMeasureStore(store, cqlOf);
  assert.equal((await store.getLatest(HEPB))?.status, "Active", "Hep B stays Active on re-seed (idempotent)");
  assert.equal((await store.listLatest()).length, MEASURE_CATALOG.length, "no duplicate rows after promotion backfill");
});

// ---------------------------------------------------------------------------
// Test A5: Does NOT clobber a user lifecycle edit to Hep B (e.g. Deprecated)
// ---------------------------------------------------------------------------
test("seedMeasureStore — promotion backfill leaves a non-Approved Hep B row untouched", async () => {
  const store = new SqliteMeasureStore(await freshDb());
  await seedMeasureStore(store, () => ""); // fresh seed: Hep B already Active (catalog status)

  // A user deprecates Hep B after the promotion.
  const hepb = await store.getLatest("hepatitis_b_vaccination_series");
  await store.setVersionStatus("hepatitis_b_vaccination_series", hepb!.versionId, { status: "Deprecated" });
  assert.equal((await store.getLatest("hepatitis_b_vaccination_series"))?.status, "Deprecated");

  // Re-seed must NOT re-promote it (gate is on the original "Approved" state only).
  await seedMeasureStore(store, () => "");
  assert.equal(
    (await store.getLatest("hepatitis_b_vaccination_series"))?.status,
    "Deprecated",
    "a deliberate Deprecated edit must survive re-seed (backfill only promotes the original Approved row)",
  );
});
