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
import { MEASURES } from "../cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";

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

  it("pins every legacy external id, provider attribution, and seeded target", () => {
    const expectedDirectory = [
      ["emp-001", "prov-005"], ["emp-002", "prov-006"], ["emp-003", "prov-005"], ["emp-004", "prov-006"],
      ["emp-005", "prov-001"], ["emp-006", "prov-002"], ["emp-007", "prov-001"], ["emp-008", "prov-002"],
      ["emp-009", "prov-001"], ["emp-010", "prov-002"], ["emp-011", "prov-003"], ["emp-012", "prov-004"],
      ["emp-013", "prov-003"], ["emp-014", "prov-004"], ["emp-015", "prov-003"], ["emp-016", "prov-004"],
      ["emp-017", "prov-003"], ["emp-018", "prov-004"], ["emp-019", "prov-003"], ["emp-020", "prov-004"],
      ["emp-021", "prov-001"], ["emp-022", "prov-002"], ["emp-023", "prov-001"], ["emp-024", "prov-002"],
      ["emp-025", "prov-001"], ["emp-026", "prov-002"], ["emp-027", "prov-001"], ["emp-028", "prov-002"],
      ["emp-029", "prov-001"], ["emp-030", "prov-002"], ["emp-031", "prov-003"], ["emp-032", "prov-004"],
      ["emp-033", "prov-003"], ["emp-034", "prov-004"], ["emp-035", "prov-003"], ["emp-036", "prov-004"],
      ["emp-037", "prov-003"], ["emp-038", "prov-004"], ["emp-039", "prov-003"], ["emp-040", "prov-004"],
      ["emp-041", "prov-007"], ["emp-042", "prov-008"], ["emp-043", "prov-007"], ["emp-044", "prov-008"],
      ["emp-045", "prov-007"], ["emp-046", "prov-008"], ["emp-047", "prov-007"], ["emp-048", "prov-008"],
      ["emp-049", "prov-007"], ["emp-050", "prov-008"], ["emp-051", "prov-001"], ["emp-052", "prov-002"],
      ["emp-053", "prov-001"], ["emp-054", "prov-002"], ["emp-055", "prov-001"], ["emp-056", "prov-002"],
      ["emp-057", "prov-001"], ["emp-058", "prov-002"], ["emp-059", "prov-001"], ["emp-060", "prov-002"],
      ["emp-061", "prov-003"], ["emp-062", "prov-004"], ["emp-063", "prov-003"], ["emp-064", "prov-004"],
      ["emp-065", "prov-003"], ["emp-066", "prov-004"], ["emp-067", "prov-003"], ["emp-068", "prov-004"],
      ["emp-069", "prov-003"], ["emp-070", "prov-004"], ["emp-071", "prov-001"], ["emp-072", "prov-002"],
      ["emp-073", "prov-001"], ["emp-074", "prov-002"], ["emp-075", "prov-001"], ["emp-076", "prov-002"],
      ["emp-077", "prov-001"], ["emp-078", "prov-002"], ["emp-079", "prov-001"], ["emp-080", "prov-002"],
      ["emp-081", "prov-003"], ["emp-082", "prov-004"], ["emp-083", "prov-003"], ["emp-084", "prov-004"],
      ["emp-085", "prov-003"], ["emp-086", "prov-004"], ["emp-087", "prov-003"], ["emp-088", "prov-004"],
      ["emp-089", "prov-003"], ["emp-090", "prov-004"], ["emp-091", "prov-007"], ["emp-092", "prov-008"],
      ["emp-093", "prov-007"], ["emp-094", "prov-008"], ["emp-095", "prov-007"], ["emp-096", "prov-008"],
      ["emp-097", "prov-007"], ["emp-098", "prov-008"], ["emp-099", "prov-007"], ["emp-100", "prov-008"],
      ["ihn-emp-001", "prov-101"], ["ihn-emp-002", "prov-102"], ["ihn-emp-003", "prov-101"], ["ihn-emp-004", "prov-102"],
      ["ihn-emp-005", "prov-101"], ["ihn-emp-006", "prov-102"], ["ihn-emp-007", "prov-101"], ["ihn-emp-008", "prov-102"],
      ["ihn-emp-009", "prov-101"], ["ihn-emp-010", "prov-102"], ["ihn-emp-011", "prov-101"], ["ihn-emp-012", "prov-102"],
      ["ihn-emp-013", "prov-101"], ["ihn-emp-014", "prov-102"], ["ihn-emp-015", "prov-101"], ["ihn-emp-016", "prov-102"],
      ["ihn-emp-017", "prov-101"], ["ihn-emp-018", "prov-103"], ["ihn-emp-019", "prov-104"], ["ihn-emp-020", "prov-103"],
      ["ihn-emp-021", "prov-104"], ["ihn-emp-022", "prov-103"], ["ihn-emp-023", "prov-104"], ["ihn-emp-024", "prov-103"],
      ["ihn-emp-025", "prov-104"], ["ihn-emp-026", "prov-103"], ["ihn-emp-027", "prov-104"], ["ihn-emp-028", "prov-103"],
      ["ihn-emp-029", "prov-104"], ["ihn-emp-030", "prov-103"], ["ihn-emp-031", "prov-104"], ["ihn-emp-032", "prov-103"],
      ["ihn-emp-033", "prov-104"], ["ihn-emp-034", "prov-103"], ["ihn-emp-035", "prov-105"], ["ihn-emp-036", "prov-106"],
      ["ihn-emp-037", "prov-105"], ["ihn-emp-038", "prov-106"], ["ihn-emp-039", "prov-105"], ["ihn-emp-040", "prov-106"],
      ["ihn-emp-041", "prov-105"], ["ihn-emp-042", "prov-106"], ["ihn-emp-043", "prov-105"], ["ihn-emp-044", "prov-106"],
      ["ihn-emp-045", "prov-105"], ["ihn-emp-046", "prov-106"], ["ihn-emp-047", "prov-105"], ["ihn-emp-048", "prov-106"],
      ["ihn-emp-049", "prov-105"], ["ihn-emp-050", "prov-106"],
    ] as const;
    assert.deepEqual(EVALUABLE_EMPLOYEES.map(({ externalId, providerId }) => [externalId, providerId]), expectedDirectory);

    const expectedNonCompliant: Record<string, Record<string, string[]>> = {
      audiogram: {
        EXCLUDED: ["emp-068", "emp-069", "emp-070"], MISSING_DATA: ["emp-071", "emp-072"],
        DUE_SOON: Array.from({ length: 14 }, (_, i) => `emp-${String(i + 73).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 14 }, (_, i) => `emp-${String(i + 87).padStart(3, "0")}`),
      },
      hazwoper: {
        EXCLUDED: ["emp-099", "emp-100", "ihn-emp-001"], MISSING_DATA: ["ihn-emp-002", "ihn-emp-003"],
        DUE_SOON: Array.from({ length: 23 }, (_, i) => `ihn-emp-${String(i + 4).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 24 }, (_, i) => `ihn-emp-${String(i + 27).padStart(3, "0")}`),
      },
      tb_surveillance: {
        EXCLUDED: ["ihn-emp-038", "ihn-emp-039", "ihn-emp-040"], MISSING_DATA: ["ihn-emp-041", "ihn-emp-042"],
        DUE_SOON: Array.from({ length: 4 }, (_, i) => `ihn-emp-${String(i + 43).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 4 }, (_, i) => `ihn-emp-${String(i + 47).padStart(3, "0")}`),
      },
      flu_vaccine: {
        EXCLUDED: ["ihn-emp-027", "ihn-emp-028", "ihn-emp-029"], MISSING_DATA: ["ihn-emp-030", "ihn-emp-031"],
        DUE_SOON: Array.from({ length: 9 }, (_, i) => `ihn-emp-${String(i + 32).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 10 }, (_, i) => `ihn-emp-${String(i + 41).padStart(3, "0")}`),
      },
      adult_immunization: {
        EXCLUDED: ["emp-071", "emp-072", "emp-073"], MISSING_DATA: ["emp-074", "emp-075"],
        DUE_SOON: Array.from({ length: 12 }, (_, i) => `emp-${String(i + 76).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 13 }, (_, i) => `emp-${String(i + 88).padStart(3, "0")}`),
      },
      mmr: {
        EXCLUDED: ["emp-071", "emp-072", "emp-073"], MISSING_DATA: ["emp-074", "emp-075"],
        DUE_SOON: Array.from({ length: 12 }, (_, i) => `emp-${String(i + 76).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 13 }, (_, i) => `emp-${String(i + 88).padStart(3, "0")}`),
      },
      varicella: {
        EXCLUDED: ["ihn-emp-021", "ihn-emp-022", "ihn-emp-023"], MISSING_DATA: ["ihn-emp-024", "ihn-emp-025"],
        DUE_SOON: Array.from({ length: 12 }, (_, i) => `ihn-emp-${String(i + 26).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 13 }, (_, i) => `ihn-emp-${String(i + 38).padStart(3, "0")}`),
      },
      hepatitis_b_vaccination_series: {
        EXCLUDED: ["emp-071", "emp-072", "emp-073"], MISSING_DATA: ["emp-074", "emp-075"],
        DUE_SOON: Array.from({ length: 12 }, (_, i) => `emp-${String(i + 76).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 13 }, (_, i) => `emp-${String(i + 88).padStart(3, "0")}`),
      },
      hypertension: {
        EXCLUDED: ["emp-059", "emp-060", "emp-061"], MISSING_DATA: ["emp-062", "emp-063"],
        DUE_SOON: Array.from({ length: 18 }, (_, i) => `emp-${String(i + 64).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 19 }, (_, i) => `emp-${String(i + 82).padStart(3, "0")}`),
      },
      diabetes_hba1c: {
        EXCLUDED: ["emp-053", "emp-054", "emp-055"], MISSING_DATA: ["emp-056", "emp-057"],
        DUE_SOON: Array.from({ length: 21 }, (_, i) => `emp-${String(i + 58).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 22 }, (_, i) => `emp-${String(i + 79).padStart(3, "0")}`),
      },
      obesity_bmi: {
        EXCLUDED: ["ihn-emp-023", "ihn-emp-024", "ihn-emp-025"], MISSING_DATA: ["ihn-emp-026", "ihn-emp-027"],
        DUE_SOON: Array.from({ length: 11 }, (_, i) => `ihn-emp-${String(i + 28).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 12 }, (_, i) => `ihn-emp-${String(i + 39).padStart(3, "0")}`),
      },
      cholesterol_ldl: {
        EXCLUDED: ["ihn-emp-012", "ihn-emp-013", "ihn-emp-014"], MISSING_DATA: ["ihn-emp-015", "ihn-emp-016"],
        DUE_SOON: Array.from({ length: 17 }, (_, i) => `ihn-emp-${String(i + 17).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 17 }, (_, i) => `ihn-emp-${String(i + 34).padStart(3, "0")}`),
      },
      cms125: {
        EXCLUDED: ["emp-071", "emp-072", "emp-073"], MISSING_DATA: ["emp-074", "emp-075"],
        DUE_SOON: Array.from({ length: 12 }, (_, i) => `emp-${String(i + 76).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 13 }, (_, i) => `emp-${String(i + 88).padStart(3, "0")}`),
      },
      cms122: {
        EXCLUDED: ["emp-071", "emp-072", "emp-073"], MISSING_DATA: ["emp-074", "emp-075"],
        DUE_SOON: Array.from({ length: 12 }, (_, i) => `emp-${String(i + 76).padStart(3, "0")}`),
        OVERDUE: Array.from({ length: 13 }, (_, i) => `emp-${String(i + 88).padStart(3, "0")}`),
      },
    };
    const expectedMatrix = Object.fromEntries(Object.entries(expectedNonCompliant).map(([measureId, buckets]) => [
      measureId,
      EVALUABLE_EMPLOYEES.map((employee) => Object.entries(buckets).find(([, ids]) => ids.includes(employee.externalId))?.[0] ?? "COMPLIANT"),
    ]));
    const actualMatrix = Object.fromEntries(Object.keys(MEASURES).map((measureId) => [
      measureId,
      EVALUABLE_EMPLOYEES.map((employee) => seededTargetFor(EVALUABLE_EMPLOYEES, MEASURE_BINDINGS[measureId]!.rateKey, employee.externalId)),
    ]));
    assert.deepEqual(actualMatrix, expectedMatrix);
  });
});
