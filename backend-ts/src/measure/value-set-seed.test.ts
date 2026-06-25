/**
 * backfillImmunizationValueSets — detach-safe E10.6 immunization value-set backfill (Codex P2).
 *   node --import tsx --test src/measure/value-set-seed.test.ts
 *
 * Verifies the backfill (a) seeds + links the immunization sets on a store that predates E10.6, and
 * (b) never re-adds a deliberately detached link (the regression that an unconditional re-seed caused).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteValueSetStore } from "../stores/sqlite/value-set-store-sqlite.ts";
import { backfillImmunizationValueSets } from "./value-set-seed.ts";

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

async function freshStore() {
  const dbPath = join(tmpdir(), `workwell-vsseed-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return new SqliteValueSetStore(db);
}

const MMR_VER = "mmr-1.0.0";
const MMR_VACCINES = "c0000001-0000-0000-0000-000000000002";
const IMMZ_ENROLL = "c0000001-0000-0000-0000-000000000001";
const HEPB_VACCINES = "c0000001-0000-0000-0000-000000000008";
const versionIdOf = (slug: string) => `${slug}-1.0.0`;

test("backfillImmunizationValueSets — seeds + links the immunization sets on a pre-E10.6 store", async () => {
  const store = await freshStore();
  await backfillImmunizationValueSets(store, versionIdOf);

  assert.ok((await store.getById(MMR_VACCINES)) !== null, "mmr-vaccines set must be back-filled");
  assert.ok((await store.getById(IMMZ_ENROLL)) !== null, "shared immz-enrollment set must be back-filled");
  const linked = await store.listByVersion(MMR_VER);
  assert.ok(linked.some((v) => v.id === MMR_VACCINES), "the mmr version must be linked to mmr-vaccines");
  assert.ok(linked.some((v) => v.id === IMMZ_ENROLL), "the mmr version must be linked to the shared enrollment set");
});

test("backfillImmunizationValueSets — does NOT re-add a deliberately detached link (detach-safe)", async () => {
  const store = await freshStore();
  await backfillImmunizationValueSets(store, versionIdOf);

  // Operator detaches mmr-vaccines from the mmr version via the governance API.
  await store.unlink(MMR_VER, MMR_VACCINES);
  assert.ok(
    !(await store.listByVersion(MMR_VER)).some((v) => v.id === MMR_VACCINES),
    "precondition: the link is detached",
  );

  // A subsequent cold start re-runs the backfill — the set already exists, so the link must NOT return.
  await backfillImmunizationValueSets(store, versionIdOf);
  assert.ok(
    !(await store.listByVersion(MMR_VER)).some((v) => v.id === MMR_VACCINES),
    "a detached immunization link must persist across re-seed (no unconditional re-link)",
  );
});

test("backfillImmunizationValueSets — additively unions missing canonical codes into an existing set (E11.2c CVX 44/45)", async () => {
  const store = await freshStore();
  // Simulate a store seeded BEFORE E11.2c: hepb-vaccines exists but lacks CVX 44/45, plus an operator-added code.
  await store.seedValueSet({
    id: HEPB_VACCINES, oid: "urn:workwell:vs:hepb-vaccines", name: "Hep B Vaccines", version: "2025-demo",
    codes: [
      { code: "hepb-vaccine", display: "Hepatitis B Vaccines", system: "urn:workwell:vs:hepb-vaccines" },
      { code: "08", display: "Hep B adolescent or pediatric", system: "http://hl7.org/fhir/sid/cvx" },
      { code: "43", display: "Hep B adult", system: "http://hl7.org/fhir/sid/cvx" },
      { code: "189", display: "Hep B Heplisav-B", system: "http://hl7.org/fhir/sid/cvx" },
      { code: "OPERATOR", display: "Operator-added", system: "http://hl7.org/fhir/sid/cvx" },
    ],
  });

  await backfillImmunizationValueSets(store, versionIdOf);

  const after = (await store.getById(HEPB_VACCINES))!;
  const codes = new Set(after.codes.map((c) => c.code));
  assert.ok(codes.has("44") && codes.has("45"), "the E11.2c traditional-schedule CVX 44/45 must be back-filled");
  assert.ok(codes.has("OPERATOR"), "operator-added codes must be preserved (additive union, not replace)");

  // Idempotent: a second run is a no-op (no duplicate codes).
  await backfillImmunizationValueSets(store, versionIdOf);
  const again = (await store.getById(HEPB_VACCINES))!;
  assert.equal(again.codes.length, after.codes.length, "re-run adds nothing (idempotent)");
});
