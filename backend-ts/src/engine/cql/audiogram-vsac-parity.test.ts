/**
 * ADR-008 safety guard (E14 / VSAC): turning VSAC on must not change audiogram outcomes. Audiogram's
 * value set is a local urn:workwell:* set, so the composite resolver (VSAC key set) routes it to the
 * store tier — identical to the inline production path. Proves inline == composite(keyed) == expected
 * across all scenarios. Mirrors the store bootstrap in value-set-resolver.test.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { SqliteValueSetStore } from "../../stores/sqlite/value-set-store-sqlite.ts";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../../stores/sqlite/schema.ts";
import { CqlExecutionEngine } from "./cql-execution-engine.ts";
import { resolveValueSetResolver } from "./resolve-value-set-resolver.ts";

const dbPath = join(tmpdir(), `workwell-vsac-parity-${crypto.randomUUID()}.sqlite`);
const VS = "urn:workwell:vs:audiogram-procedures";
const SYNTH = fileURLToPath(new URL("../../../spike/synthetic/audiogram", import.meta.url));
const EVAL = "2026-06-12";
const EXPECTED: Record<string, string> = {
  present_recent: "COMPLIANT",
  present_old: "OVERDUE",
  missing: "MISSING_DATA",
  excluded: "EXCLUDED",
};
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

test("audiogram: inline == composite(VSAC key on) == expected, across all scenarios", async () => {
  const inline = new CqlExecutionEngine(); // today's production default (no resolver)
  const keyed = new CqlExecutionEngine({
    valueSetResolver: resolveValueSetResolver({ WORKWELL_VSAC_API_KEY: "test-key-not-used-for-urn" }, store),
  });
  for (const [scenario, expected] of Object.entries(EXPECTED)) {
    const bundle = JSON.parse(readFileSync(join(SYNTH, `${scenario}.json`), "utf8"));
    const inlineOut = await inline.evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: EVAL });
    const keyedOut = await keyed.evaluate({ measureId: "audiogram", patientBundle: bundle, evaluationDate: EVAL });
    assert.equal(inlineOut.outcome, expected, `inline ${scenario}`);
    assert.equal(keyedOut.outcome, expected, `composite(keyed) ${scenario}`);
    assert.equal(keyedOut.outcome, inlineOut.outcome, `parity ${scenario}`);
  }
});
