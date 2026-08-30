import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPLOYEES,
  EVALUABLE_EMPLOYEES,
  EVALUATION_EXCLUDED_TENANTS,
  PROVIDERS,
  TENANTS,
  employeesForTenant,
} from "./employee-catalog.ts";
import { seededTargetFor } from "../../run/distribution.ts";

const MAUI_SITES = new Set(["Wailuku Clinic", "Kihei Clinic"]);

describe("maui synthetic tenant (directory-only until MM-1)", () => {
  it("exists as a tenant with exactly 48 patient personas across both clinics", () => {
    assert.ok(TENANTS.some((t) => t.id === "maui"));
    const maui = employeesForTenant("maui");
    // Hand-written data — the exact count is knowable and anchors the directory's composition.
    assert.equal(maui.length, 48);
    for (const p of maui) {
      assert.match(p.externalId, /^pat-\d{3}$/, p.externalId);
      assert.equal(p.role, "Patient", p.externalId);
      assert.ok(MAUI_SITES.has(p.site), `${p.externalId} at unexpected site ${p.site}`);
      assert.ok(p.dateOfBirth, p.externalId);
    }
    for (const site of MAUI_SITES) {
      assert.ok(maui.some((p) => p.site === site), `no personas at ${site}`);
    }
  });

  it("every maui subject is attributed to a maui provider at their own clinic", () => {
    const providerById = new Map(PROVIDERS.map((p) => [p.id, p]));
    for (const p of employeesForTenant("maui")) {
      const provider = providerById.get(p.providerId);
      assert.ok(provider, `${p.externalId} has no resolvable provider`);
      assert.equal(provider!.tenantId, "maui", p.externalId);
      assert.equal(provider!.location, p.site, p.externalId);
    }
  });

  it("is evaluation-excluded: the evaluable population is exactly the pre-maui directory", () => {
    assert.ok(EVALUATION_EXCLUDED_TENANTS.has("maui"));
    assert.ok(EVALUABLE_EMPLOYEES.every((e) => e.tenantId !== "maui"));
    // twh + ihn, byte-identical to the population every seeded distribution ran over before this
    // tenant existed — adding maui must not reshuffle existing tenants' targets (demo stability).
    const legacy = [...employeesForTenant("twh"), ...employeesForTenant("ihn")];
    assert.deepEqual(
      EVALUABLE_EMPLOYEES.map((e) => e.externalId),
      legacy.map((e) => e.externalId),
    );
    assert.equal(EMPLOYEES.length, EVALUABLE_EMPLOYEES.length + 48);
  });

  it("preserves an existing subject's seeded target (the reshuffle canary)", () => {
    // Under a naive global distribution over all 198 directory rows, emp-053's diabetes_hba1c
    // target flips EXCLUDED -> COMPLIANT (measured in review). Pinning the historical value over
    // the evaluable population keeps that regression loud.
    assert.equal(seededTargetFor(EVALUABLE_EMPLOYEES, "diabetes_hba1c", "emp-053"), "EXCLUDED");
  });
});
