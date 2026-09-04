/**
 * Scale-tenant rollup subtree (#185 E13 PR-2): build mhn tenant→enterprise→location→provider(leaf)
 * from bounded group-counts; reconciles; null when empty.
 *   node --import tsx --test src/program/scale-rollup.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScaleSubtree } from "./scale-rollup.ts";
import type { ScaleGroupCount } from "../stores/outcome-store.ts";

test("buildScaleSubtree → tenant→enterprise→location→provider(leaf), reconciling", () => {
  const groups: ScaleGroupCount[] = [
    { locationId: "L00", providerId: "P00", status: "COMPLIANT", count: 2 },
    { locationId: "L00", providerId: "P00", status: "OVERDUE", count: 1 },
    { locationId: "L00", providerId: "P01", status: "COMPLIANT", count: 1 },
  ];
  const tenant = buildScaleSubtree(groups)!;
  assert.equal(tenant.level, "tenant");
  assert.equal(tenant.id, "mhn");
  assert.equal(tenant.totals.evaluated, 4);
  assert.equal(tenant.totals.compliant, 3);
  const ent = tenant.children[0]!;
  assert.equal(ent.level, "enterprise");
  const loc = ent.children.find((c) => c.id === "L00")!;
  assert.equal(loc.level, "location");
  assert.equal(loc.totals.evaluated, 4);
  // provider ids are location-qualified (L00:P00) to avoid duplicate keys when multiple
  // mhn locations are expanded simultaneously in the hierarchy UI (Fix 3, Codex P2).
  const p00 = loc.children.find((c) => c.id === "L00:P00")!;
  assert.equal(p00.level, "provider");
  assert.equal(p00.children.length, 0, "provider is a leaf (no 120k patients)");
  assert.equal(p00.totals.evaluated, 3);
  assert.equal(p00.totals.compliant, 2);
  // reconciles: location = Σ providers; tenant/enterprise = Σ locations
  const sumProv = loc.children.reduce((s, p) => s + p.totals.evaluated, 0);
  assert.equal(loc.totals.evaluated, sumProv);
  assert.equal(tenant.totals.complianceRate, 75);
});

test("empty groups → null (no scale data)", () => {
  assert.equal(buildScaleSubtree([]), null);
});

test("buildScaleSubtree removes excluded from compliance rate denominator (e.g. 38 compliant, 7 overdue, 3 excluded -> 84.4)", () => {
  const groups: ScaleGroupCount[] = [
    { locationId: "L00", providerId: "P00", status: "COMPLIANT", count: 38 },
    { locationId: "L00", providerId: "P00", status: "OVERDUE", count: 7 },
    { locationId: "L00", providerId: "P00", status: "EXCLUDED", count: 3 },
  ];
  const tenant = buildScaleSubtree(groups)!;
  assert.equal(tenant.totals.evaluated, 48);
  assert.equal(tenant.totals.compliant, 38);
  assert.equal(tenant.totals.excluded, 3);
  // CMS rate: 38 / (48 - 3) = 38 / 45 = 84.4%
  assert.equal(tenant.totals.complianceRate, 84.4);
});
