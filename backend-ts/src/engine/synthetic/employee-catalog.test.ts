/**
 * Employee catalog tests (#107; multi-tenant #185 E13 PR-1) — the ported synthetic directory,
 * now spanning two tenants (twh + ihn).
 *   node --import tsx --test src/engine/synthetic/employee-catalog.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPLOYEES, employeeById, PROVIDERS, ENTERPRISE, providerById, providersForLocation,
  TENANTS, tenantById, enterpriseForTenant, employeesForTenant,
} from "./employee-catalog.ts";

test("the synthetic catalog has unique ids across both tenants", () => {
  assert.equal(new Set(EMPLOYEES.map((e) => e.externalId)).size, EMPLOYEES.length, "external ids are unique");
  assert.equal(employeesForTenant("twh").length, 100, "tenant 1 keeps the original 100");
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

test("provider attribution is deterministic (stable across imports)", () => {
  const first = EMPLOYEES.map((e) => `${e.externalId}:${e.providerId}`).join(",");
  for (const e of EMPLOYEES) assert.equal(providerById(e.providerId)!.location, e.site);
  assert.ok(first.includes("emp-006:prov-002"), "deterministic attribution: emp-006 → prov-002");
});

// ---- multi-tenant (#185 E13 PR-1) ----

test("two tenants exist with stable ids/names", () => {
  assert.deepEqual(TENANTS.map((t) => t.id).sort(), ["ihn", "twh"]);
  assert.equal(tenantById("twh")?.name, "Total Worker Health");
  assert.equal(tenantById("ihn")?.name, "Indus Hospital Network");
  assert.equal(tenantById("nope"), null);
});

test("ENTERPRISE remains tenant 1's enterprise (back-compat)", () => {
  assert.equal(ENTERPRISE.id, "twh");
  assert.ok(ENTERPRISE.name.length > 0);
});

test("every employee and provider resolves to a known tenant", () => {
  const ids = new Set(TENANTS.map((t) => t.id));
  for (const e of EMPLOYEES) assert.ok(ids.has(e.tenantId), `${e.externalId} tenant`);
  for (const p of PROVIDERS) assert.ok(ids.has(p.tenantId), `${p.id} tenant`);
});

test("tenant 1 keeps the original 100 employees unchanged on twh", () => {
  const twh = employeesForTenant("twh");
  assert.equal(twh.length, 100);
  assert.equal(twh[0]!.externalId, "emp-001");
  assert.ok(twh.every((e) => e.tenantId === "twh"));
  assert.equal(employeeById("emp-006")?.site, "Plant A");
  assert.equal(employeeById("emp-006")?.providerId, "prov-002");
});

test("tenant 2 (ihn) adds ~50 employees with distinct ids/providers, partitioning EMPLOYEES", () => {
  const ihn = employeesForTenant("ihn");
  assert.ok(ihn.length >= 40 && ihn.length <= 60, `ihn size ${ihn.length}`);
  assert.ok(ihn.every((e) => e.externalId.startsWith("ihn-emp-")));
  assert.ok(ihn.every((e) => e.tenantId === "ihn"));
  assert.equal(employeesForTenant("twh").length + ihn.length, EMPLOYEES.length);
  const p = providerById(ihn[0]!.providerId)!;
  assert.equal(p.tenantId, "ihn");
});

test("enterpriseForTenant maps each tenant to its enterprise", () => {
  assert.equal(enterpriseForTenant("twh")?.id, "twh");
  assert.equal(enterpriseForTenant("ihn")?.name, "Indus Hospital Network");
});
