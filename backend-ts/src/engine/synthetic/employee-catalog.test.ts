/**
 * Employee catalog tests (#107) — the ported synthetic directory.
 *   node --import tsx --test src/engine/synthetic/employee-catalog.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPLOYEES, employeeById } from "./employee-catalog.ts";

test("the synthetic catalog ports the full Java workforce with unique ids", () => {
  assert.equal(EMPLOYEES.length, 100);
  assert.equal(new Set(EMPLOYEES.map((e) => e.externalId)).size, 100, "external ids are unique");
});

test("employeeById resolves known ids and returns null for unknown (no throw)", () => {
  assert.deepEqual(employeeById("emp-006"), { externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A" });
  assert.equal(employeeById("nobody"), null);
});
