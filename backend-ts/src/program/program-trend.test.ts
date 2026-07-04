/**
 * UX-8 — monthly-snapshot program trend. Unit-tests the two pure helpers + the monthly/fallback
 * wiring in programTrend.
 *   node --import tsx --test src/program/program-trend.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Task 2 adds `monthlyTrendPoints` and Task 3 adds `programDeps`/`ProgramDeps` + `programTrend` to this
// import as those tasks are implemented. Task 1 uses only `snapshotScopeFor`.
import { snapshotScopeFor } from "./program-read-models.ts";
import type { QualitySnapshotRow } from "../stores/quality-snapshot-store.ts";

test("snapshotScopeFor — no tenant/site → all/ALL", () => {
  assert.deepEqual(snapshotScopeFor({}), { scopeLevel: "all", scopeId: "ALL" });
});

test("snapshotScopeFor — tenant only → tenant/<id>", () => {
  assert.deepEqual(snapshotScopeFor({ tenant: "ihn" }), { scopeLevel: "tenant", scopeId: "ihn" });
});

test("snapshotScopeFor — tenant + site → site/<tenant|site>", () => {
  assert.deepEqual(snapshotScopeFor({ tenant: "twh", site: "Plant A" }), { scopeLevel: "site", scopeId: "twh|Plant A" });
});

test("snapshotScopeFor — site alone resolves its tenant from the directory", () => {
  // "Plant A" belongs to twh in the synthetic directory → resolves uniquely.
  assert.deepEqual(snapshotScopeFor({ site: "Plant A" }), { scopeLevel: "site", scopeId: "twh|Plant A" });
});

test("snapshotScopeFor — unknown site (no tenant) → null (fall back to per-run)", () => {
  assert.equal(snapshotScopeFor({ site: "Nowhere" }), null);
});
