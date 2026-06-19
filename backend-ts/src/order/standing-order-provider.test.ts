// backend-ts/src/order/standing-order-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulatedStandingOrderProvider, ehStandingOrderProvider, resolveStandingOrderProvider } from "./standing-order-provider.ts";

test("simulated provider is deterministic per subject", () => {
  const a = simulatedStandingOrderProvider.activeOrdersFor("emp-006");
  const b = simulatedStandingOrderProvider.activeOrdersFor("emp-006");
  assert.deepEqual(a, b);
});

test("simulated provider suppresses some subjects but not all (across emp-001..emp-100)", () => {
  let withOrders = 0;
  for (let i = 1; i <= 100; i++) {
    const id = `emp-${String(i).padStart(3, "0")}`;
    if (simulatedStandingOrderProvider.activeOrdersFor(id).length > 0) withOrders++;
  }
  assert.ok(withOrders > 0 && withOrders < 100, `expected partial coverage, got ${withOrders}/100`);
});

test("resolveStandingOrderProvider returns simulated by default", () => {
  assert.equal(resolveStandingOrderProvider({}), simulatedStandingOrderProvider);
  assert.equal(resolveStandingOrderProvider({ WORKWELL_EH_FHIR_API_KEY: "k" }), simulatedStandingOrderProvider);
});

test("resolveStandingOrderProvider returns the inert EH stub only when both env vars set", () => {
  const p = resolveStandingOrderProvider({ WORKWELL_EH_FHIR_API_KEY: "k", WORKWELL_EH_FHIR_BASE_URL: "https://eh.example/fhir" });
  assert.notEqual(p, simulatedStandingOrderProvider);
  assert.deepEqual(p.activeOrdersFor("emp-006"), []); // inert: no orders, no HTTP
});
