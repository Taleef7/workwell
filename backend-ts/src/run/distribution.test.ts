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
  // audiogram rate 0.78 over 100 employees: 78 compliant, 3 excluded, 2 missing,
  // remaining 17 → 8 due-soon / 9 overdue.
  const counts = seededDistribution(EMPLOYEES, "audiogram").reduce<Record<string, number>>((acc, a) => {
    acc[a.target] = (acc[a.target] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { COMPLIANT: 78, EXCLUDED: 3, MISSING_DATA: 2, DUE_SOON: 8, OVERDUE: 9 });
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
