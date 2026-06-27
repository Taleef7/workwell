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
import { EMPLOYEES, employeesForTenant } from "../engine/synthetic/employee-catalog.ts";
import { isApplicable } from "./segment-applicability.ts";

const baselineRule = () => DEMO_SEGMENTS.find((s) => s.name === "All Employees")!.rule;

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

test("the universal baseline covers every directory site across all tenants (incl. IHN)", () => {
  const rule = baselineRule();
  const cond = rule.conditions.find((c) => c.attr === "site" && c.op === "in")!;
  const sites = new Set(Array.isArray(cond.value) ? cond.value : [cond.value]);
  for (const site of new Set(EMPLOYEES.map((e) => e.site))) {
    assert.ok(sites.has(site), `baseline "All Employees" must cover site ${site}`);
  }
  // explicitly the new IHN campuses
  for (const s of ["North Campus", "South Campus", "Outpatient Clinic"]) {
    assert.ok(sites.has(s), `baseline must cover IHN site ${s}`);
  }
});

test("IHN employees are applicable to the baseline wellness/eCQM measures under the seeded segments", async () => {
  const db = await freshDb();
  const store = new SqliteSegmentStore(db);
  await seedSegments(store);
  const segments = await store.listSegments();
  // ihn-emp-002 is a Physician at North Campus — matches only the "All Employees" baseline.
  const physician = employeesForTenant("ihn").find((e) => e.role === "Physician")!;
  assert.ok(isApplicable(physician, "hypertension", segments), "IHN physician applicable to baseline hypertension");
  assert.ok(isApplicable(physician, "adult_immunization", segments), "IHN physician applicable to adult_immunization");
});

test("seeding is name-idempotent — an already-seeded baseline is left untouched (owner-gated repair)", async () => {
  const db = await freshDb();
  const store = new SqliteSegmentStore(db);
  // An operator-customized "All Employees" already exists; a re-seed must not clobber it (the
  // E13 site widening for an already-seeded row is an owner-gated audited route edit, not a boot write).
  const operatorRule = { match: "ANY" as const, conditions: [{ attr: "role" as const, op: "contains" as const, value: "Nurse" }] };
  await store.createSegment({ name: "All Employees", description: "operator", rule: operatorRule, measureIds: ["hypertension"] });
  await seedSegments(store);
  const after = (await store.listSegments()).find((s) => s.name === "All Employees")!;
  assert.deepEqual(after.rule, operatorRule, "existing baseline must be left as-is");
});

test("demo seed covers every Active runnable measure (no measure orphaned)", () => {
  const covered = new Set(DEMO_SEGMENTS.flatMap((s) => s.measureIds));
  const orphaned = Object.keys(MEASURES).filter((id) => !covered.has(id));
  assert.deepEqual(orphaned, [], `every runnable measure must be in ≥1 demo cohort; orphaned: ${orphaned.join(", ")}`);
  // And every seeded measure id must be a real runnable measure (no typos).
  const unknown = [...covered].filter((id) => !(id in MEASURES));
  assert.deepEqual(unknown, [], `demo cohorts reference unknown measure ids: ${unknown.join(", ")}`);
});
