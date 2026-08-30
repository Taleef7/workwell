import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPLOYEES, TENANTS, employeesForTenant } from "./employee-catalog.ts";
import { seededDistribution } from "../../run/distribution.ts";

describe("maui synthetic tenant", () => {
  it("exists as a tenant with a primary-care cohort of at least 40", () => {
    assert.ok(TENANTS.some((t) => t.id === "maui"));
    assert.ok(employeesForTenant("maui").length >= 40);
  });

  it("every maui subject carries an attributed provider (the future PCP field)", () => {
    for (const p of employeesForTenant("maui")) {
      assert.ok(p.providerId, p.externalId);
      assert.ok(p.dateOfBirth, p.externalId);
    }
  });

  it("yields every outcome bucket for each runnable primary-care measure", () => {
    const maui = employeesForTenant("maui");
    for (const rateKey of ["diabetes_hba1c", "hypertension", "cholesterol_ldl", "obesity_bmi", "cms125"]) {
      const d = seededDistribution(maui, rateKey);
      const targets = new Set(d.map(({ target }) => target));
      for (const bucket of ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"] as const) {
        assert.ok(targets.has(bucket), `${rateKey} missing ${bucket}`);
      }
    }
  });

  it("does not disturb the existing twh/ihn cohorts", () => {
    assert.equal(
      employeesForTenant("twh").length + employeesForTenant("ihn").length,
      EMPLOYEES.length - employeesForTenant("maui").length,
    );
  });
});
