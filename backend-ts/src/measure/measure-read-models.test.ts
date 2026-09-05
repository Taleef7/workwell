/**
 * Read-model tests (#107). Focus: the E14 jurisdiction field (#186) — defaults to "US" on the
 * MeasureDetail, surfaced read-time from the engine registry. node --import tsx --test src/measure/measure-read-models.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toMeasure, toMeasureDetail } from "./measure-read-models.ts";
import type { MeasureRecord } from "../stores/measure-store.ts";

function record(measureId: string): MeasureRecord {
  return {
    measureId,
    name: "Test Measure",
    policyRef: "ref",
    owner: "system",
    tags: [],
    versionId: `${measureId}-v1.0`,
    version: "v1.0",
    status: "Active",
    spec: {
      description: "d",
      eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
      exclusions: [],
      complianceWindow: "Annual",
      requiredDataElements: [],
      testFixtures: [],
    },
    cqlText: "",
    compileStatus: "COMPILED",
    changeSummary: null,
    approvedBy: null,
    activatedAt: null,
    createdAt: "2026-06-26T00:00:00Z",
    updatedAt: "2026-06-26T00:00:00Z",
  };
}

test("toMeasureDetail defaults jurisdiction to US (E14 / #186)", () => {
  const d = toMeasureDetail(record("cms122"));
  assert.equal(d.jurisdiction, "US");
});

test("toMeasureDetail defaults jurisdiction to US for a measure absent from the registry", () => {
  const d = toMeasureDetail(record("some-catalog-draft"));
  assert.equal(d.jurisdiction, "US");
});
test("toMeasure carries routing computed by classifyRunnable at call time", () => {
  assert.equal(toMeasure(record("cms125")).routing, "authored");
  assert.equal(toMeasure(record("cms165")).routing, "official-pending");

  const previous = process.env.WORKWELL_OFFICIAL_MEASURES;
  try {
    process.env.WORKWELL_OFFICIAL_MEASURES = "cms165";
    assert.equal(toMeasure(record("cms165")).routing, "official");
  } finally {
    if (previous === undefined) delete process.env.WORKWELL_OFFICIAL_MEASURES;
    else process.env.WORKWELL_OFFICIAL_MEASURES = previous;
  }
});

test("a measure no engine can run says so, rather than borrowing the authored label", () => {
  assert.equal(toMeasure(record("not-in-any-registry")).routing, "not-runnable");
  // The list must still render it — the field is descriptive, never a filter.
  assert.equal(toMeasure(record("not-in-any-registry")).id, "not-in-any-registry");
});
