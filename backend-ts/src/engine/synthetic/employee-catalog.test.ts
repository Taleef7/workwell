/**
 * Employee catalog tests (#107) — the ported synthetic directory.
 *   node --import tsx --test src/engine/synthetic/employee-catalog.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPLOYEES, employeeById, PROVIDERS, ENTERPRISE, providerById, providersForLocation,
} from "./employee-catalog.ts";

test("the synthetic catalog ports the full Java workforce with unique ids", () => {
  assert.equal(EMPLOYEES.length, 100);
  assert.equal(new Set(EMPLOYEES.map((e) => e.externalId)).size, 100, "external ids are unique");
});

test("employeeById resolves known ids and returns null for unknown (no throw)", () => {
  const emp = employeeById("emp-006");
  assert.ok(emp);
  assert.equal(emp!.externalId, "emp-006");
  assert.equal(emp!.name, "Omar Siddiq");
  assert.equal(emp!.role, "Welder");
  assert.equal(emp!.site, "Plant A");
  assert.equal(employeeById("nobody"), null);
});

test("every employee is attributed to a provider at the SAME location", () => {
  for (const e of EMPLOYEES) {
    const p = providerById(e.providerId);
    assert.ok(p, `employee ${e.externalId} has unresolved provider ${e.providerId}`);
    assert.equal(p!.location, e.site, `provider ${p!.id} location must equal employee ${e.externalId} site`);
  }
});

test("PROVIDERS: unique ids, 2 per location, every employee site is covered", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "provider ids unique");
  const sites = [...new Set(EMPLOYEES.map((e) => e.site))];
  for (const site of sites) {
    assert.equal(providersForLocation(site).length, 2, `location ${site} has exactly 2 providers`);
  }
});

test("ENTERPRISE is the single tenant root", () => {
  assert.equal(ENTERPRISE.id, "twh");
  assert.ok(ENTERPRISE.name.length > 0);
});

test("provider attribution is deterministic (stable across imports)", () => {
  const first = EMPLOYEES.map((e) => `${e.externalId}:${e.providerId}`).join(",");
  for (const e of EMPLOYEES) assert.equal(providerById(e.providerId)!.location, e.site);
  assert.ok(first.includes("emp-006:prov-002"), "deterministic attribution: emp-006 → prov-002");
});
