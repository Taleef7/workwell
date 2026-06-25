/**
 * Demo-segment seed test (#183 E11.3). Proves seedSegments creates the demo cohorts, is idempotent by
 * name (a second run / a boot over an already-seeded DB adds no duplicates), and that the cohorts'
 * rule-sets together cover EVERY Active runnable measure (no measure is silently orphaned by the seed —
 * which, since the seed ships ENABLED, would otherwise read NOT_APPLICABLE for everyone on the roster).
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
import { MEASURES } from "../engine/cql/measure-registry.ts";

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

test("demo seed covers every Active runnable measure (no measure orphaned)", () => {
  const covered = new Set(DEMO_SEGMENTS.flatMap((s) => s.measureIds));
  const orphaned = Object.keys(MEASURES).filter((id) => !covered.has(id));
  assert.deepEqual(orphaned, [], `every runnable measure must be in ≥1 demo cohort; orphaned: ${orphaned.join(", ")}`);
  // And every seeded measure id must be a real runnable measure (no typos).
  const unknown = [...covered].filter((id) => !(id in MEASURES));
  assert.deepEqual(unknown, [], `demo cohorts reference unknown measure ids: ${unknown.join(", ")}`);
});
