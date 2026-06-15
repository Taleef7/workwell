/**
 * Traceability generator unit test (#107) — rows map policy→spec→CQL→evidence and gaps flag
 * governance issues, purely from a MeasureRecord.
 *   node --import tsx --test src/measure/measure-traceability.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeasureRecord } from "../stores/measure-store.ts";
import { generateTraceability } from "./measure-traceability.ts";

function record(over: Partial<MeasureRecord> = {}): MeasureRecord {
  return {
    measureId: "audiogram",
    name: "Annual Audiogram Completed",
    policyRef: "OSHA 29 CFR 1910.95",
    owner: "system",
    tags: [],
    versionId: "audiogram-v1.0",
    version: "v1.0",
    status: "Active",
    spec: {
      description: "Annual audiogram.",
      eligibilityCriteria: { roleFilter: "Welder", siteFilter: "Plant A", programEnrollmentText: "Hearing Conservation Program" },
      exclusions: [{ label: "Waiver", criteriaText: "Valid waiver on file" }],
      complianceWindow: "Annual",
      requiredDataElements: ["Last audiogram date"],
      testFixtures: [
        { fixtureName: "c", employeeExternalId: "emp-001", expectedOutcome: "COMPLIANT", notes: "" },
        { fixtureName: "m", employeeExternalId: "emp-004", expectedOutcome: "MISSING_DATA", notes: "" },
        { fixtureName: "x", employeeExternalId: "emp-005", expectedOutcome: "EXCLUDED", notes: "" },
      ],
    },
    cqlText:
      'define "In Hearing Conservation Program": true\ndefine "Has Active Waiver": false\ndefine "Most Recent Audiogram Date": null\ndefine "Days Since Last Audiogram": 0\ndefine "Outcome Status": \'OVERDUE\'',
    compileStatus: "COMPILED",
    changeSummary: null,
    approvedBy: null,
    activatedAt: "2026-06-10T00:00:00.000Z",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...over,
  };
}

test("generateTraceability maps eligibility/exclusion/window rows to CQL defines", () => {
  const t = generateTraceability(record());
  assert.equal(t.measureId, "audiogram");
  assert.equal(t.measureVersionId, "audiogram-v1.0");
  const eligibility = t.rows.find((r) => r.specField === "eligibilityCriteria")!;
  assert.match(eligibility.specValue, /Hearing Conservation Program/);
  assert.equal(eligibility.cqlDefine, "In Hearing Conservation Program");
  assert.deepEqual(eligibility.runtimeEvidenceKeys, ["role_eligible", "site_eligible"]);

  const exclusion = t.rows.find((r) => r.specField === "exclusions")!;
  assert.equal(exclusion.cqlDefine, "Has Active Waiver");
  assert.deepEqual(exclusion.runtimeEvidenceKeys, ["waiver_status"]);

  const window = t.rows.find((r) => r.policyRequirement.startsWith("Compliance window"))!;
  assert.ok(window.runtimeEvidenceKeys.includes("outcome_status"));

  // a distinct "Days Since" define yields the days-elapsed row
  assert.ok(t.rows.some((r) => r.cqlDefine === "Days Since Last Audiogram"));
});

test("generateTraceability raises gaps: no value sets always; compile/fixture/policy when missing", () => {
  // Healthy seed: only the value-set gap (no governance on the TS floor).
  const healthy = generateTraceability(record());
  assert.ok(healthy.gaps.some((g) => /value sets/i.test(g.message)));
  assert.ok(!healthy.gaps.some((g) => /compile status/i.test(g.message)), "COMPILED → no compile gap");
  assert.ok(!healthy.gaps.some((g) => /No test fixtures/i.test(g.message)), "has fixtures");

  // Broken: NOT_COMPILED + no fixtures + no policy → ERROR compile gap + fixture gap + policy gap.
  const broken = generateTraceability(record({ compileStatus: "NOT_COMPILED", policyRef: "", spec: { ...record().spec, testFixtures: [] } }));
  assert.ok(broken.gaps.some((g) => g.severity === "ERROR" && /compile status/i.test(g.message)));
  assert.ok(broken.gaps.some((g) => /No test fixtures/i.test(g.message)));
  assert.ok(broken.gaps.some((g) => /policy citation/i.test(g.message)));
});

test("generateTraceability flags missing MISSING_DATA / EXCLUDED fixture coverage", () => {
  const t = generateTraceability(record({ spec: { ...record().spec, testFixtures: [{ fixtureName: "c", employeeExternalId: "emp-001", expectedOutcome: "COMPLIANT", notes: "" }] } }));
  assert.ok(t.gaps.some((g) => /MISSING_DATA/.test(g.message)));
  assert.ok(t.gaps.some((g) => /EXCLUDED/.test(g.message)));
});
