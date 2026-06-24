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

  it("applies the display-state class and stays readable for NA", () => {
    const { container } = render(<ComplianceChip cell={{ status: "NA", method: "Not evaluated" }} />);
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(container.querySelector("span")?.className).toContain("neutral");
  });

  it("renders IN_PROGRESS with its blue chip", () => {
    const { container } = render(<ComplianceChip cell={{ status: "IN_PROGRESS", method: "1 of 2 doses on file" }} />);
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(container.innerHTML).toContain("blue");
  });
});
