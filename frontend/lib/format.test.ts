import { describe, expect, it } from "vitest";
import { formatEvaluationPeriod } from "./format";

describe("formatEvaluationPeriod", () => {
  it("formats a canonical year period for the patient-term behavior", () => {
    expect(formatEvaluationPeriod("2026-01-01")).toBe("2026");
  });

  it("preserves non-year and nullish periods", () => {
    expect(formatEvaluationPeriod("2026-Q1")).toBe("2026-Q1");
    expect(formatEvaluationPeriod(null)).toBe("");
    expect(formatEvaluationPeriod(undefined)).toBe("");
  });
});
