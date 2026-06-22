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
