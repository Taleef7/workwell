import { after, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteSegmentStore } from "../stores/sqlite/segment-store-sqlite.ts";
import { seedSegments, DEMO_SEGMENTS, demoSegmentsFor } from "./segment-seed.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { EMPLOYEES, employeesForTenant } from "../engine/synthetic/employee-catalog.ts";
import { isApplicable } from "./segment-applicability.ts";
import { WEBCHART_LIVE_SITE } from "../engine/ingress/webchart/live-directory.ts";
import type { CreateSegmentInput, HydratedSegment } from "../stores/segment-store.ts";
import { composeDeploymentDirectory, resolveDeploymentProfile, type DeploymentProfileId } from "../config/deployment-profile.ts";

const baselineRule = () => DEMO_SEGMENTS.find((s) => s.name === "All Employees")!.rule;

// Snapshot pinning the pre-change default seed byte-for-byte (default profile is unchanged).
const DEFAULT_SNAPSHOT: CreateSegmentInput[] = [
  {
    name: "All Employees",
    description: "Universal occupational-health baseline — wellness screening, preventive eCQMs, and the adult Td/Tdap booster, applicable to everyone.",
    rule: { match: "ANY", conditions: [{ attr: "site", op: "in", value: ["Clinic", "HQ", "Kihei Clinic", "North Campus", "Outpatient Clinic", "Plant A", "Plant B", "South Campus", "Wailuku Clinic", "WebChart"] }] },
    measureIds: ["hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "cms125", "cms122", "adult_immunization"],
  },
  {
    name: "OSHA Safety-Sensitive",
    description: "Field roles in OSHA surveillance programs — adds audiometry, HAZWOPER, and TB screening.",
    rule: { match: "ANY", conditions: [
      { attr: "role", op: "contains", value: "Welder" },
      { attr: "role", op: "contains", value: "Maintenance" },
      { attr: "role", op: "contains", value: "Hazwoper" },
      { attr: "role", op: "contains", value: "Industrial Hygienist" },
    ] },
    measureIds: ["audiogram", "hazwoper", "tb_surveillance"],
  },
  {
    name: "Clinical Staff",
    description: "Clinic-based and nursing staff — adds influenza, TB screening, and the MMR/Varicella/Hep B immunity series.",
    rule: { match: "ANY", conditions: [
      { attr: "site", op: "equals", value: "Clinic" },
      { attr: "role", op: "contains", value: "Nurse" },
    ] },
    measureIds: ["flu_vaccine", "tb_surveillance", "mmr", "varicella", "hepatitis_b_vaccination_series"],
  },
];

function mauiSegments(): CreateSegmentInput[] {
  const profile = resolveDeploymentProfile("maui");
  const dir = composeDeploymentDirectory(profile);
  return demoSegmentsFor("maui" as DeploymentProfileId, dir.EMPLOYEES, [...profile.runnableMeasureIds]);
}

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
  const operatorRule = { match: "ANY" as const, conditions: [{ attr: "role" as const, op: "contains" as const, value: "Nurse" }] };
  await store.createSegment({ name: "All Employees", description: "operator", rule: operatorRule, measureIds: ["hypertension"] });
  await seedSegments(store);
  const after = (await store.listSegments()).find((s) => s.name === "All Employees")!;
  assert.deepEqual(after.rule, operatorRule, "existing baseline must be left as-is");
});

// ---- per-profile seed invariants (2026-09-02) ----

test("demo seed covers every runnable measure on the default profile (no measure orphaned)", () => {
  const covered = new Set(DEMO_SEGMENTS.flatMap((s) => s.measureIds));
  const orphaned = Object.keys(MEASURES).filter((id) => !covered.has(id));
  assert.deepEqual(orphaned, [], `every runnable measure must be in ≥1 demo cohort; orphaned: ${orphaned.join(", ")}`);
  const unknown = [...covered].filter((id) => !(id in MEASURES));
  assert.deepEqual(unknown, [], `demo cohorts reference unknown measure ids: ${unknown.join(", ")}`);
});

test("maui seed covers every runnable measure on the maui profile (no measure orphaned)", () => {
  const maui = mauiSegments();
  const profile = resolveDeploymentProfile("maui");
  const runnable = profile.runnableMeasureIds;
  const covered = new Set(maui.flatMap((s) => s.measureIds));
  const orphaned = [...runnable].filter((id) => !covered.has(id));
  assert.deepEqual(orphaned, [], `every maui runnable measure must be in the maui seed; orphaned: ${orphaned.join(", ")}`);
  const extra = [...covered].filter((id) => !runnable.includes(id));
  assert.deepEqual(extra, [], `maui seed must reference only profile-runnable measures; extra: ${extra.join(", ")}`);
});

test("maui seed has one All Patients segment scoped to the maui directory sites with no employee/OSHA wording", () => {
  const maui = mauiSegments();
  assert.equal(maui.length, 1, "maui profile seeds exactly one segment");
  assert.equal(maui[0]!.name, "All Patients");
  const dir = composeDeploymentDirectory(resolveDeploymentProfile("maui"));
  const expectedSites = [...new Set(dir.EMPLOYEES.map((e) => e.site))].sort((a, b) => a.localeCompare(b));
  const cond = maui[0]!.rule.conditions.find((c: any) => c.attr === "site" && c.op === "in");
  assert.ok(cond, "maui seed matches by site IN a list");
  assert.deepEqual(cond.value, expectedSites, "maui seed site list must equal the maui directory's distinct sites");
  const serialized = JSON.stringify(maui).toLowerCase();
  assert.ok(!serialized.includes("employee"), "maui seed must not contain employee wording");
  assert.ok(!serialized.includes("osha"), "maui seed must not contain OSHA wording");
});

test("default seed is deep-equal to the pinned pre-change constant (byte-identical default profile)", () => {
  assert.deepEqual(DEMO_SEGMENTS, DEFAULT_SNAPSHOT, "DEMO_SEGMENTS must remain byte-identical on the default profile");
  const defaultDir = composeDeploymentDirectory(resolveDeploymentProfile("default"));
  const mauiFromDefault = demoSegmentsFor("maui" as DeploymentProfileId, defaultDir.EMPLOYEES, ["hypertension"]);
  assert.equal(mauiFromDefault.length, 1, "demoSegmentsFor must select the maui set regardless of the loaded process profile");
  assert.equal(mauiFromDefault[0]!.name, "All Patients");
});
// ---------------------------------------------------------------------------
// Demo-readiness (#): the universal baseline must cover the live WebChart site.
//
// The live WebChart tenant places every subject at the fixed site "WebChart", added at runtime when
// the tenant loads — so the boot-time seed's directory-derived site list (twh/ihn only) never
// covers it, and every WebChart roster cell reads NOT_APPLICABLE (the applicability overlay only
// counts sites named by an ENABLED segment). Since the demo runs the app against the shim, the
// baseline must include the live site out of the box, with no manual admin step to forget.
// ---------------------------------------------------------------------------

test("the All Employees baseline covers the live WebChart site (roster shows real chips, not N-A)", async () => {
  const rule = baselineRule();
  const siteCond = rule.conditions.find((c) => c.attr === "site" && c.op === "in");
  assert.ok(siteCond, "baseline matches by site IN a list");
  const sites = siteCond.value as string[];
  assert.ok(
    sites.includes(WEBCHART_LIVE_SITE),
    `baseline site list must include "${WEBCHART_LIVE_SITE}" so live WebChart subjects are applicable`,
  );

  // A live WebChart subject must be applicable to a baseline wellness measure (i.e. NOT overlaid N-A).
  const wcSubject = { externalId: "wc|wc-5", name: "Jane Doe", role: "employee", tenantId: "wc", site: WEBCHART_LIVE_SITE, providerId: "wc-provider-1" };
  const baseline = DEMO_SEGMENTS.find((s) => s.name === "All Employees")!;
  const seg: HydratedSegment = {
    id: "seg-baseline", name: baseline.name, description: baseline.description ?? "",
    enabled: true, rule: baseline.rule, measureIds: baseline.measureIds, overrides: [],
    createdBy: "test", createdAt: "2026-07-22T00:00:00Z", updatedAt: "2026-07-22T00:00:00Z",
  };
  assert.equal(
    isApplicable(wcSubject, "hypertension", [seg]),
    true,
    "a live WebChart subject must be applicable to the baseline wellness panel",
  );
});
