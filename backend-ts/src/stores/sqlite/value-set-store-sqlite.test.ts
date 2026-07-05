/**
 * SQLite-floor unit tests for SqliteValueSetStore.upsertResolvedValueSet (VSAC expansion import).
 *   node --import tsx --test src/stores/sqlite/value-set-store-sqlite.test.ts
 *
 * Proves the resolve-valuesets CLI's store write: an OID-keyed upsert of real codes + resolution
 * metadata into existing value_sets columns (no DDL), idempotent by OID (incl. null version).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "./schema.ts";
import { SqliteValueSetStore } from "./value-set-store-sqlite.ts";

const created: string[] = [];
after(() => {
  for (const p of created) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

async function makeStore(): Promise<SqliteValueSetStore> {
  const dbPath = join(tmpdir(), `workwell-vsstore-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return new SqliteValueSetStore(db);
}

test("upsertResolvedValueSet inserts a VSAC row and re-resolves idempotently by oid", async () => {
  const store = await makeStore();
  const oid = "2.16.840.1.113883.3.464.1003.103.12.1001";
  await store.upsertResolvedValueSet({
    oid,
    name: "Diabetes",
    version: "20240101",
    source: "VSAC",
    codes: [{ code: "44054006", display: "T2DM", system: "http://snomed.info/sct" }],
    resolutionStatus: "RESOLVED",
    resolutionError: null,
    expansionHash: "h1",
    lastResolvedAt: "2026-07-05T00:00:00.000Z",
  });
  let all = await store.listAll();
  const row = all.find((v) => v.oid === oid);
  assert.ok(row);
  assert.equal(row!.source, "VSAC");
  assert.equal(row!.resolutionStatus, "RESOLVED");
  assert.equal(row!.governanceStatus, "ACTIVE");
  assert.equal(row!.expansionHash, "h1");
  assert.equal(row!.codes.length, 1);
  assert.equal(row!.codes[0]!.code, "44054006");

  await store.upsertResolvedValueSet({
    oid,
    name: "Diabetes",
    version: "20240101",
    source: "VSAC",
    codes: [
      { code: "44054006", display: "T2DM", system: "http://snomed.info/sct" },
      { code: "E11.9", display: "T2DM", system: "http://hl7.org/fhir/sid/icd-10-cm" },
    ],
    resolutionStatus: "RESOLVED",
    resolutionError: null,
    expansionHash: "h2",
    lastResolvedAt: "2026-07-05T01:00:00.000Z",
  });
  all = await store.listAll();
  assert.equal(all.filter((v) => v.oid === oid).length, 1);
  assert.equal(all.find((v) => v.oid === oid)!.codes.length, 2);
});

test("upsertResolvedValueSet records an ERROR row with no codes", async () => {
  const store = await makeStore();
  const oid = "2.16.840.1.113883.3.464.1003.1003";
  await store.upsertResolvedValueSet({
    oid,
    name: oid,
    version: null,
    source: "VSAC",
    codes: [],
    resolutionStatus: "ERROR",
    resolutionError: "500 Server Error",
    expansionHash: null,
    lastResolvedAt: "2026-07-05T00:00:00.000Z",
  });
  const row = (await store.listAll()).find((v) => v.oid === oid);
  assert.ok(row);
  assert.equal(row!.resolutionStatus, "ERROR");
  assert.equal(row!.resolutionError, "500 Server Error");
  assert.equal(row!.codes.length, 0);
});

test("upsertResolvedValueSet is idempotent by oid with a null version (the version the CLI passes)", async () => {
  const store = await makeStore();
  const oid = "2.16.840.1.113883.3.464.1003.198.12.1012";
  const base = {
    oid,
    name: "Null-version set",
    version: null,
    source: "VSAC",
    resolutionStatus: "RESOLVED",
    resolutionError: null,
    expansionHash: "hn",
    lastResolvedAt: "2026-07-05T00:00:00.000Z",
  } as const;
  await store.upsertResolvedValueSet({ ...base, codes: [{ code: "1", display: "one", system: "http://snomed.info/sct" }] });
  await store.upsertResolvedValueSet({
    ...base,
    codes: [
      { code: "1", display: "one", system: "http://snomed.info/sct" },
      { code: "2", display: "two", system: "http://snomed.info/sct" },
    ],
  });
  const matches = (await store.listAll()).filter((v) => v.oid === oid);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.codes.length, 2);
});
