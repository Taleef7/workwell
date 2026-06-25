import { test } from "node:test";
import assert from "node:assert/strict";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { matchesRule, matchesCohort, applicableMeasures, isApplicable } from "./segment-applicability.ts";

const emp = (over: Partial<EmployeeProfile> = {}): EmployeeProfile => ({
  externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A", providerId: "prov-001", ...over,
});

const seg = (over: Partial<HydratedSegment> = {}): HydratedSegment => ({
  id: "s1", name: "S1", description: "", enabled: true,
  rule: { match: "ANY", conditions: [] }, measureIds: [], overrides: [],
  createdBy: "x", createdAt: "t", updatedAt: "t", ...over,
});

test("matchesRule: contains is case-insensitive substring on role", () => {
  const e = emp({ role: "Welder / Hazwoper Responder" });
  assert.equal(matchesRule(e, { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "hazwoper" }] }), true);
  assert.equal(matchesRule(e, { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "nurse" }] }), false);
});

test("matchesRule: equals + in on site; ALL vs ANY", () => {
  const e = emp({ site: "Clinic", role: "Nurse" });
  assert.equal(matchesRule(e, { match: "ANY", conditions: [{ attr: "site", op: "equals", value: "clinic" }] }), true);
  assert.equal(matchesRule(e, { match: "ANY", conditions: [{ attr: "site", op: "in", value: ["HQ", "Clinic"] }] }), true);
  assert.equal(matchesRule(e, { match: "ALL", conditions: [
    { attr: "site", op: "equals", value: "Clinic" }, { attr: "role", op: "contains", value: "welder" },
  ] }), false);
});

test("matchesRule: empty conditions match nobody", () => {
  assert.equal(matchesRule(emp(), { match: "ANY", conditions: [] }), false);
});

test("matchesCohort: EXCLUDE beats INCLUDE even with conflicting duplicate overrides (any order)", () => {
  const r = { match: "ANY" as const, conditions: [] };
  assert.equal(matchesCohort(emp(), seg({ rule: r, overrides: [
    { externalId: "emp-006", mode: "INCLUDE" }, { externalId: "emp-006", mode: "EXCLUDE" },
  ] })), false);
  assert.equal(matchesCohort(emp(), seg({ rule: r, overrides: [
    { externalId: "emp-006", mode: "EXCLUDE" }, { externalId: "emp-006", mode: "INCLUDE" },
  ] })), false);
});

test("matchesCohort: EXCLUDE override wins, INCLUDE forces in", () => {
  const ruleHazwoper = { match: "ANY" as const, conditions: [{ attr: "role" as const, op: "contains" as const, value: "Welder" }] };
  assert.equal(matchesCohort(emp(), seg({ rule: ruleHazwoper, overrides: [{ externalId: "emp-006", mode: "EXCLUDE" }] })), false);
  assert.equal(matchesCohort(emp({ role: "Office Staff" }), seg({ rule: ruleHazwoper, overrides: [{ externalId: "emp-006", mode: "INCLUDE" }] })), true);
});

test("applicableMeasures: union across enabled matching segments; disabled ignored", () => {
  const e = emp({ role: "Welder", site: "Plant A" });
  const a = seg({ id: "a", rule: { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "Welder" }] }, measureIds: ["audiogram", "hazwoper"] });
  const b = seg({ id: "b", enabled: false, rule: { match: "ANY", conditions: [{ attr: "site", op: "equals", value: "Plant A" }] }, measureIds: ["flu_vaccine"] });
  const got = applicableMeasures(e, [a, b]);
  assert.deepEqual([...got].sort(), ["audiogram", "hazwoper"]);
});

test("isApplicable: zero enabled segments ⇒ everything applies (reversibility)", () => {
  assert.equal(isApplicable(emp(), "audiogram", []), true);
  assert.equal(isApplicable(emp(), "audiogram", [seg({ enabled: false, measureIds: ["audiogram"] })]), true);
});

test("isApplicable: with enabled segments, out-of-cohort measure is not applicable", () => {
  const s = seg({ rule: { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "Welder" }] }, measureIds: ["audiogram"] });
  assert.equal(isApplicable(emp({ role: "Welder" }), "audiogram", [s]), true);
  assert.equal(isApplicable(emp({ role: "Office Staff" }), "audiogram", [s]), false);
});
