/**
 * Demo-segment seed test (#183 E11.3). Proves seedSegments creates the four demo cohorts and is
 * idempotent by name — a second run (or a boot over an already-seeded DB) adds no duplicates.
 *   node --import tsx --test src/segment/segment-seed.test.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteSegmentStore } from "../stores/sqlite/segment-store-sqlite.ts";
import { seedSegments, DEMO_SEGMENTS } from "./segment-seed.ts";

const created: string[] = [];

async function freshDb() {
  const dbPath = join(tmpdir(), `workwell-segment-seed-${crypto.randomUUID()}.sqlite`);
  created.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return db;
}

after(() => {
  for (const p of created) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test("seedSegments creates the demo segments and is idempotent by name", async () => {
  const db = await freshDb();
  const store = new SqliteSegmentStore(db);
  await seedSegments(store);
  await seedSegments(store); // second run must not duplicate
  const all = await store.listSegments();
  assert.equal(all.length, DEMO_SEGMENTS.length);
  assert.ok(all.find((s) => s.name === "OSHA Safety-Sensitive"));
  assert.ok(all.find((s) => s.name === "All Employees"));
});
