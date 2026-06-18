/**
 * #90 / E3.2 — ValueSetResolver: store-backed expansion + populated cql.CodeService.
 *   node --import tsx --test src/engine/cql/value-set-resolver.test.ts
 *
 * Import-name adaptations vs. the plan:
 *   - `runMigrations` does not exist; the real symbol is `migrateFloorSchema` from schema.ts.
 *   - The full schema DDL is `RUN_STORE_FLOOR_DDL` (also from schema.ts); we exec it before
 *     calling `migrateFloorSchema` (column backfill), matching the pattern in run-store-sqlite.test.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { SqliteValueSetStore } from "../../stores/sqlite/value-set-store-sqlite.ts";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../../stores/sqlite/schema.ts";
import { StoreValueSetResolver, buildCodeService } from "./value-set-resolver.ts";

const dbPath = join(tmpdir(), `workwell-vsr-${crypto.randomUUID()}.sqlite`);
const VS = "urn:workwell:vs:audiogram-procedures";
let store: SqliteValueSetStore;

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  await migrateFloorSchema(db);
  store = new SqliteValueSetStore(db);
  await store.seedValueSet({
    id: "a0000001-0000-0000-0000-000000000001",
    oid: VS,
    name: "Audiogram Procedures",
    version: "1",
    codes: [{ code: "audiogram-procedure", display: "Audiogram procedure", system: VS }],
  });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* ignore */
  }
});

test("StoreValueSetResolver.expand maps a seeded value set to CqlCode[]", async () => {
  const resolver = new StoreValueSetResolver(store);
  assert.deepEqual(await resolver.expand(VS), [{ code: "audiogram-procedure", system: VS }]);
});

test("StoreValueSetResolver.expand returns [] for an unknown value set", async () => {
  const resolver = new StoreValueSetResolver(store);
  assert.deepEqual(await resolver.expand("urn:workwell:vs:nope"), []);
});

test("buildCodeService produces a CodeService that resolves the value set by url", async () => {
  const resolver = new StoreValueSetResolver(store);
  const cs = (await buildCodeService(resolver, [VS])) as {
    findValueSet: (oid: string) => { codes: Array<{ code: string; system: string }> } | null;
  };
  const found = cs.findValueSet(VS);
  assert.ok(found, "value set should resolve");
  assert.ok(found.codes.some((c) => c.code === "audiogram-procedure" && c.system === VS));
});
