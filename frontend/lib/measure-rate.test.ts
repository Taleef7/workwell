import { describe, expect, it } from "vitest";
import { displayRate, type NotationSource } from "./measure-rate";

const baseCounts = {
  compliant: 38,
  dueSoon: 0,
  overdue: 7,
  missingData: 0,
  excluded: 3,
  complianceRate: 84.4,
};

const increase: NotationSource = { improvementNotation: "increase" };
const decrease: NotationSource = { improvementNotation: "decrease" };

describe("displayRate", () => {
  it("returns compliance for increase notation", () => {
    expect(displayRate(baseCounts, increase)).toEqual({
      label: "Compliance",
      value: 84.4,
      lowerIsBetter: false,
      numerator: 38,
      denominator: 45,
    });
  });

  it("returns poor control for decrease notation: overdue / (compliant + dueSoon + overdue)", () => {
    expect(displayRate(baseCounts, decrease)).toEqual({
      label: "Poor control",
      value: 15.6,
      lowerIsBetter: true,
      numerator: 7,
      denominator: 45,
    });
  });

  it("treats an absent or empty notation as increase", () => {
    expect(displayRate(baseCounts, null).label).toBe("Compliance");
    expect(displayRate(baseCounts, undefined).label).toBe("Compliance");
    expect(displayRate(baseCounts, {}).label).toBe("Compliance");
  });

  it("returns zero poor control when the denominator is zero", () => {
    const r = displayRate({ ...baseCounts, compliant: 0, dueSoon: 0, overdue: 0, complianceRate: 0 }, decrease);
    expect(r).toMatchObject({ label: "Poor control", value: 0, numerator: 0, denominator: 0 });
  });

  it("excludes missingData from numerator and denominator for decrease notation", () => {
    const r = displayRate({ ...baseCounts, missingData: 5 }, decrease);
    expect(r).toMatchObject({ value: 15.6, numerator: 7, denominator: 45 });
  });

  it("includes dueSoon in the denominator for decrease notation", () => {
    const r = displayRate({ ...baseCounts, dueSoon: 5 }, decrease);
    // 7 / (38 + 5 + 7) = 14.0
    expect(r).toMatchObject({ value: 14, numerator: 7, denominator: 50 });
  });

  it("increase: the denominator is total minus excluded, so missingData and dueSoon both count", () => {
    const r = displayRate({ ...baseCounts, missingData: 2, dueSoon: 5, complianceRate: 73.1 }, increase);
    expect(r).toMatchObject({ label: "Compliance", value: 73.1, numerator: 38, denominator: 52 });
  });

  it("accepts any object carrying improvementNotation (a program summary), not only a MeasureIdentity", () => {
    const program = { ...baseCounts, measureId: "cms122", improvementNotation: "decrease" as const };
    expect(displayRate(program, program).label).toBe("Poor control");
  });
});
