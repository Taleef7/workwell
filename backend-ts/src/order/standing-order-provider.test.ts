// backend-ts/src/order/standing-order-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { noStandingOrderProvider, resolveStandingOrderProvider } from "./standing-order-provider.ts";

test("#616: with no order source configured, no patient has a standing order and nothing is checked", () => {
  // The old default invented one for ~1 subject in 5 from a hash of the id; on the pilot it withheld 46
  // real proposals. Every id shape either stack uses, the pilot's whole corpus included.
  const ids = [
    ...Array.from({ length: 20_000 }, (_, i) => `pat-${String(i + 1).padStart(5, "0")}`),
    ...Array.from({ length: 100 }, (_, i) => `emp-${String(i + 1).padStart(3, "0")}`),
  ];
  // Half-configured is still unconfigured: both EH variables are required.
  for (const env of [{}, { WORKWELL_EH_FHIR_API_KEY: "k" }, { WORKWELL_EH_FHIR_BASE_URL: "https://eh.example/fhir" }]) {
    const provider = resolveStandingOrderProvider(env);
    assert.equal(provider, noStandingOrderProvider);
    assert.equal(provider.checksExistingOrders, false, "an empty answer is 'not checked', never 'none on file'");
    const withOrders = ids.filter((id) => provider.activeOrdersFor(id).length > 0);
    assert.deepEqual(withOrders, [], "no invented standing orders");
  }
});

test("resolveStandingOrderProvider returns the inert EH stub only when both env vars set", () => {
  const p = resolveStandingOrderProvider({ WORKWELL_EH_FHIR_API_KEY: "k", WORKWELL_EH_FHIR_BASE_URL: "https://eh.example/fhir" });
  assert.notEqual(p, noStandingOrderProvider);
  assert.deepEqual(p.activeOrdersFor("emp-006"), []); // inert: no orders, no HTTP
  // A stub that queries nothing has checked nothing, so the page must not read its silence as "none".
  assert.equal(p.checksExistingOrders, false);
});
