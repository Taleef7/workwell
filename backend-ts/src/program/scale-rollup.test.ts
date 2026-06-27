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
  const p00 = loc.children.find((c) => c.id === "P00")!;
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
