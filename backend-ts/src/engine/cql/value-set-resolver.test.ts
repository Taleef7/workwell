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
    findValueSet: (oid: string, version?: string) => { codes: Array<{ code: string; system: string }> } | null;
  };
  const found = cs.findValueSet(VS);
  assert.ok(found, "value set should resolve (no version)");
  assert.ok(found.codes.some((c) => c.code === "audiogram-procedure" && c.system === VS));
  // The ELM retrieve binds via findValueSet(url, version) — lock the "1" version-key shape too.
  const versioned = cs.findValueSet(VS, "1");
  assert.ok(versioned, "value set should resolve by version key");
  assert.ok(versioned.codes.some((c) => c.code === "audiogram-procedure" && c.system === VS));
});

// ---------------------------------------------------------------------------
// Cross-mode parity: expansion mode must yield the same outcome as inline mode
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CqlExecutionEngine } from "./cql-execution-engine.ts";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic/audiogram", import.meta.url));
const EVAL = "2026-06-12";
const EXPECTED: Record<string, string> = {
  present_recent: "COMPLIANT",
  present_old: "OVERDUE",
  missing: "MISSING_DATA",
  excluded: "EXCLUDED",
};

test("audiogram: expansion mode == inline mode == expected, across all scenarios", async () => {
  const inline = new CqlExecutionEngine();
  const expansion = new CqlExecutionEngine({ valueSetResolver: new StoreValueSetResolver(store) });
  for (const [scenario, expected] of Object.entries(EXPECTED)) {
    const bundle = JSON.parse(readFileSync(join(SYNTH, `${scenario}.json`), "utf8"));
    const inlineOut = await inline.evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: EVAL });
    const expandOut = await expansion.evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: EVAL });
    assert.equal(inlineOut.outcome, expected, `inline ${scenario}`);
    assert.equal(expandOut.outcome, expected, `expansion ${scenario}`);
    assert.equal(expandOut.outcome, inlineOut.outcome, `cross-mode ${scenario}`);
  }
});
