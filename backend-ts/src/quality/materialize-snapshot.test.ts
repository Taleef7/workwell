/**
 * E16 — quality snapshot pure core (`buildSnapshotRows`). Aggregates a population run's live outcomes
 * (+ the pre-aggregated scale tenant) into per-(measure, period, scope) numerator/denominator + the 5
 * bucket counts, reconciling All = Σ tenants = Σ sites = Σ providers. Pure + dependency-injected
 * scope resolver — no DB, no employee-catalog import. Mirrors the hierarchy-rollup accumulation.
 *   node --import tsx --test src/quality/materialize-snapshot.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshotRows, type BuildSnapshotInput } from "./materialize-snapshot.ts";
import type { QualitySnapshotInput, QualityScopeLevel } from "../stores/quality-snapshot-store.ts";

const SCOPES: Record<string, { tenantId: string; site: string; providerId: string }> = {
  s1: { tenantId: "twh", site: "HQ", providerId: "prov-001" },
  s2: { tenantId: "twh", site: "HQ", providerId: "prov-002" },
  s3: { tenantId: "ihn", site: "North Campus", providerId: "prov-101" },
};

function baseInput(): BuildSnapshotInput {
  return {
    measureId: "audiogram",
    period: "2026-06",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-06-30T23:59:59.999Z",
    sourceRunId: "run-1",
    computedAt: "2026-06-30T12:00:00.000Z",
    liveOutcomes: [
      { subjectId: "s1", status: "COMPLIANT" },
      { subjectId: "s2", status: "OVERDUE" },
      { subjectId: "s3", status: "EXCLUDED" },
    ],
    resolveScope: (id) => SCOPES[id] ?? null,
    scale: {
      tenantId: "mhn",
      groups: [
        { locationId: "L00", providerId: "P00", status: "COMPLIANT", count: 3 },
        { locationId: "L00", providerId: "P00", status: "DUE_SOON", count: 1 },
        { locationId: "L01", providerId: "P02", status: "MISSING_DATA", count: 2 },
      ],
    },
  };
}

const find = (rows: QualitySnapshotInput[], level: QualityScopeLevel, scopeId: string) =>
  rows.find((r) => r.scopeLevel === level && r.scopeId === scopeId);

test("buildSnapshotRows: the 'all' row aggregates live + scale into num/denom + 5 buckets", () => {
  const rows = buildSnapshotRows(baseInput());
  const all = find(rows, "all", "ALL");
  assert.ok(all, "an 'all' row exists");
  assert.equal(all.tenantId, null, "'all' row has null tenantId");
  assert.equal(all.measureId, "audiogram");
  assert.equal(all.period, "2026-06");
  assert.equal(all.periodStart, "2026-06-01T00:00:00.000Z");
  assert.equal(all.sourceRunId, "run-1");
  assert.equal(all.computedAt, "2026-06-30T12:00:00.000Z");
  assert.equal(all.compliant, 4); // s1 + mhn L00|P00 (3)
  assert.equal(all.overdue, 1); // s2
  assert.equal(all.excluded, 1); // s3
  assert.equal(all.dueSoon, 1); // mhn
  assert.equal(all.missingData, 2); // mhn
  assert.equal(all.numerator, 4); // = COMPLIANT
  assert.equal(all.denominator, 8); // total(9) − excluded(1)
});

test("buildSnapshotRows: tenant/site/provider rows carry tenantId + hierarchical scopeId", () => {
  const rows = buildSnapshotRows(baseInput());

  const mhn = find(rows, "tenant", "mhn");
  assert.ok(mhn);
  assert.equal(mhn.tenantId, "mhn");
  assert.equal(mhn.compliant, 3);
  assert.equal(mhn.numerator, 3);
  assert.equal(mhn.denominator, 6); // total 6 − excluded 0

  const site = find(rows, "site", "mhn|L00");
  assert.ok(site);
  assert.equal(site.tenantId, "mhn");
  assert.equal(site.compliant, 3);
  assert.equal(site.dueSoon, 1);

  const prov = find(rows, "provider", "mhn|L00|P00");
  assert.ok(prov);
  assert.equal(prov.compliant, 3);
  assert.equal(prov.dueSoon, 1);
  assert.equal(prov.numerator, 3);

  const twhProv = find(rows, "provider", "twh|HQ|prov-002");
  assert.ok(twhProv);
  assert.equal(twhProv.overdue, 1);
});

test("buildSnapshotRows: reconciles All = Σ tenants = Σ sites = Σ providers (every count)", () => {
  const rows = buildSnapshotRows(baseInput());
  const all = find(rows, "all", "ALL");
  assert.ok(all);
  const KEYS = ["numerator", "denominator", "compliant", "dueSoon", "overdue", "missingData", "excluded"] as const;
  for (const level of ["tenant", "site", "provider"] as const) {
    const levelRows = rows.filter((r) => r.scopeLevel === level);
    for (const k of KEYS) {
      const sum = levelRows.reduce((a, r) => a + r[k], 0);
      assert.equal(sum, all[k], `Σ ${level}.${k} = all.${k}`);
    }
  }
});

test("buildSnapshotRows: row count is O(scopes), independent of subject N (scale pre-aggregated)", () => {
  const input = baseInput();
  // Inflate the scale counts massively — the row count must not change (bounded by construction).
  input.scale!.groups = input.scale!.groups.map((g) => ({ ...g, count: g.count * 1_000_000 }));
  const rows = buildSnapshotRows(input);
  assert.equal(rows.filter((r) => r.scopeLevel === "all").length, 1);
  assert.equal(rows.filter((r) => r.scopeLevel === "tenant").length, 3); // twh, ihn, mhn
  assert.equal(rows.filter((r) => r.scopeLevel === "site").length, 4); // twh|HQ, ihn|North Campus, mhn|L00, mhn|L01
  assert.equal(rows.filter((r) => r.scopeLevel === "provider").length, 5);
});

test("buildSnapshotRows: skips subjects the resolver can't place (unknown subject)", () => {
  const input = baseInput();
  input.liveOutcomes.push({ subjectId: "ghost", status: "COMPLIANT" });
  const rows = buildSnapshotRows(input);
  const all = find(rows, "all", "ALL");
  assert.ok(all);
  assert.equal(all.compliant, 4, "the unresolvable subject is not counted anywhere");
});

test("buildSnapshotRows: no scale tenant → live-only, still reconciles", () => {
  const input = baseInput();
  delete input.scale;
  const rows = buildSnapshotRows(input);
  const all = find(rows, "all", "ALL");
  assert.ok(all);
  assert.equal(all.compliant, 1); // only s1
  assert.equal(all.excluded, 1); // s3
  assert.equal(all.denominator, 2); // total 3 − excluded 1
  assert.equal(rows.filter((r) => r.scopeLevel === "tenant").length, 2); // twh, ihn only
});
