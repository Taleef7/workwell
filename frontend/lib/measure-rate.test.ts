import { describe, expect, it } from "vitest";
import { displayRate } from "./measure-rate";

const baseCounts = {
  compliant: 38,
  dueSoon: 0,
  overdue: 7,
  missingData: 0,
  excluded: 3,
  complianceRate: 84.4,
};

describe("displayRate", () => {
  it("returns compliance for increase notation", () => {
    const result = displayRate(baseCounts, { cmsId: "CMS125", mipsQualityId: "112", improvementNotation: "increase" });
    expect(result).toEqual({ label: "Compliance", value: 84.4, lowerIsBetter: false });
  });

  it("returns poor control for decrease notation", () => {
    const result = displayRate(baseCounts, { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" });
    expect(result).toEqual({ label: "Poor control", value: 15.6, lowerIsBetter: true });
  });

  it("returns zero poor control when denominator is zero", () => {
    const result = displayRate(
      { compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, excluded: 5, complianceRate: 0 },
      { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" },
    );
    expect(result).toEqual({ label: "Poor control", value: 0, lowerIsBetter: true });
  });

  it("excludes missingData from numerator and denominator for decrease notation", () => {
    const countsWithMissing = { ...baseCounts, missingData: 10 };
    const result = displayRate(countsWithMissing, { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" });
    expect(result).toEqual({ label: "Poor control", value: 15.6, lowerIsBetter: true });
  });

  it("includes dueSoon in denominator for decrease notation", () => {
    const countsWithDueSoon = {
      compliant: 30,
      dueSoon: 10,
      overdue: 10,
      missingData: 0,
      excluded: 0,
      complianceRate: 60.0,
    };
    const result = displayRate(countsWithDueSoon, { cmsId: "CMS122", mipsQualityId: "001", improvementNotation: "decrease" });
    expect(result).toEqual({ label: "Poor control", value: 20, lowerIsBetter: true });
  });

  it("handles missingData > 0 and dueSoon > 0 for increase notation", () => {
    const counts = {
      compliant: 30,
      dueSoon: 10,
      overdue: 10,
      missingData: 5,
      excluded: 2,
      complianceRate: 60.0,
    };
    const result = displayRate(counts, { cmsId: "CMS125", mipsQualityId: "112", improvementNotation: "increase" });
    expect(result).toEqual({ label: "Compliance", value: 60.0, lowerIsBetter: false });
  });
});
