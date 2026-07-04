import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComplianceChip } from "./ComplianceChip";

describe("ComplianceChip", () => {
  it("renders the status label and method subtext", () => {
    render(<ComplianceChip cell={{ status: "COMPLIANT", method: "2 valid dose(s)" }} />);
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(screen.getByText("2 valid dose(s)")).toBeInTheDocument();
  });

  it("de-emphasizes NA to a dash but keeps the label + method accessible (UX-4)", () => {
    render(<ComplianceChip cell={{ status: "NA", method: "Not evaluated" }} />);
    // No full "N/A" pill; a dim dash carries the meaning via title + aria-label instead.
    expect(screen.queryByText("N/A")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByLabelText("N/A — Not evaluated")).toBeInTheDocument();
  });

  it("de-emphasizes NOT_APPLICABLE the same way (segment overlay)", () => {
    render(<ComplianceChip cell={{ status: "NOT_APPLICABLE", method: "Outside cohort" }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByLabelText(/Outside cohort/)).toBeInTheDocument();
  });

  it("renders IN_PROGRESS with its blue chip", () => {
    const { container } = render(<ComplianceChip cell={{ status: "IN_PROGRESS", method: "1 of 2 doses on file" }} />);
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(container.innerHTML).toContain("blue");
  });
});
