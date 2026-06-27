/**
 * Seeded-distribution tests (#107) — Java-parity ordering + bucket proportions.
 *   node --import tsx --test src/run/distribution.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { javaHashCode, orderedEmployees, seededDistribution, seededDistributionAtRate, seededTargetFor } from "./distribution.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { complianceRate } from "./compliance-rates.ts";

test("javaHashCode matches Java String.hashCode for known values", () => {
  assert.equal(javaHashCode(""), 0);
  assert.equal(javaHashCode("a"), 97);
  assert.equal(javaHashCode("ab"), 3105); // 97*31 + 98
  assert.equal(javaHashCode("audiogram"), "audiogram".split("").reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0));
});

test("ordering is deterministic and a complete permutation of the population", () => {
  const a = orderedEmployees(EMPLOYEES, "audiogram").map((e) => e.externalId);
  const b = orderedEmployees(EMPLOYEES, "audiogram").map((e) => e.externalId);
  assert.deepEqual(a, b, "deterministic");
  assert.equal(new Set(a).size, EMPLOYEES.length, "no dropped/duplicated employees");
  assert.deepEqual([...a].sort(), [...EMPLOYEES].map((e) => e.externalId).sort(), "permutation of the full set");
  // NOTE: the rateKey enters the Java hash as a constant offset, so for the
  // sequentially-numbered demo ids the relative order is ~stable across measures —
  // that's the Java behaviour we mirror, not a bug. The proportions test below is
  // the meaningful parity check.
});

test("seededDistribution splits the population into the Java proportions", () => {
  // Derive the expected split from N + the base rate (the documented formula in distribution.ts):
  // compliant = round(N*rate); excluded ≤ 3; missing ≤ 2; the remainder splits half DUE_SOON / half
  // OVERDUE. Computed from N (not hardcoded) so it stays correct as the synthetic directory grows
  // (a second tenant landed in E13; population-scale lands in E13 PR-2).
  const n = EMPLOYEES.length;
  const compliant = Math.round(n * complianceRate("audiogram")); // audiogram base rate 0.78
  const excluded = Math.min(3, n - compliant);
  const missing = Math.min(2, n - compliant - excluded);
  const remaining = n - compliant - excluded - missing;
  const dueSoon = Math.trunc(remaining / 2);
  const overdue = remaining - dueSoon;

  const counts = seededDistribution(EMPLOYEES, "audiogram").reduce<Record<string, number>>((acc, a) => {
    acc[a.target] = (acc[a.target] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { COMPLIANT: compliant, EXCLUDED: excluded, MISSING_DATA: missing, DUE_SOON: dueSoon, OVERDUE: overdue });
});

test("seededTargetFor returns the bucket a specific employee lands in (employee-scoped runs)", () => {
  const t = seededTargetFor(EMPLOYEES, "audiogram", "emp-006");
  assert.ok(["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"].includes(t!));
  assert.equal(seededTargetFor(EMPLOYEES, "audiogram", "nobody"), null);
});

// ---- synthetic trend history: seededDistributionAtRate (rate-parameterized) ----------------

test("seededDistributionAtRate compliant count matches round(N * rate)", () => {
  const n = EMPLOYEES.length;
  for (const rate of [0.4, 0.55, 0.7, 0.85, 0.99]) {
    const assigned = seededDistributionAtRate(EMPLOYEES, "audiogram", rate);
    const compliant = assigned.filter((a) => a.target === "COMPLIANT").length;
    assert.equal(compliant, Math.round(n * rate), `rate ${rate}`);
    assert.equal(assigned.length, n, "every employee is assigned a bucket");
  }
});

test("seededDistributionAtRate at a higher rate yields more compliant", () => {
  const low = seededDistributionAtRate(EMPLOYEES, "audiogram", 0.5).filter((a) => a.target === "COMPLIANT").length;
  const high = seededDistributionAtRate(EMPLOYEES, "audiogram", 0.9).filter((a) => a.target === "COMPLIANT").length;
  assert.ok(high > low, `expected higher rate to produce more compliant: ${low} vs ${high}`);
});

test("seededDistribution default == seededDistributionAtRate at the base rate (no behavior change)", () => {
  for (const key of ["audiogram", "hazwoper", "tb_surveillance"]) {
    const viaDefault = seededDistribution(EMPLOYEES, key);
    const viaRate = seededDistributionAtRate(EMPLOYEES, key, complianceRate(key));
    assert.deepEqual(
      viaDefault.map((a) => ({ id: a.employee.externalId, target: a.target })),
      viaRate.map((a) => ({ id: a.employee.externalId, target: a.target })),
      `${key} default distribution drifted from the base-rate distribution`,
    );
  }
});
