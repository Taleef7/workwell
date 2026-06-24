import { describe, expect, it } from "vitest";
import { COMPLIANCE_STATUS_LABELS, complianceStatusClass, labelFor } from "@/lib/status";

describe("compliance status vocabulary", () => {
  it("labels all 8 display states", () => {
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "COMPLIANT")).toBe("Compliant");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "DUE_SOON")).toBe("Due Soon");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "OVERDUE")).toBe("Overdue");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "MISSING_DATA")).toBe("Missing Data");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "EXCLUDED")).toBe("Excluded");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "DECLINED")).toBe("Declined");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "IN_PROGRESS")).toBe("In Progress");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "NA")).toBe("N/A");
  });

  it("gives each display state a distinct, dark-mode-aware class", () => {
    expect(complianceStatusClass("COMPLIANT")).toContain("emerald");
    expect(complianceStatusClass("DUE_SOON")).toContain("amber");
    expect(complianceStatusClass("OVERDUE")).toContain("rose");
    expect(complianceStatusClass("MISSING_DATA")).toContain("violet");
    expect(complianceStatusClass("EXCLUDED")).toContain("indigo");
    expect(complianceStatusClass("DECLINED")).toContain("orange");
    expect(complianceStatusClass("IN_PROGRESS")).toContain("blue");
    expect(complianceStatusClass("NA")).toContain("dark:");
    expect(complianceStatusClass("in progress")).toBe(complianceStatusClass("IN_PROGRESS"));
  });
});
