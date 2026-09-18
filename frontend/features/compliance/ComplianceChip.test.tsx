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

  // #569 — the third state. The status pill stays whatever CQL says, so this marker is the only
  // thing on the grid telling a coordinator why an Overdue row is on nobody's work list.
  it("marks a cell whose case a PERSON closed, without touching the CQL status", () => {
    render(
      <ComplianceChip
        cell={{
          status: "OVERDUE",
          method: "Overdue — last 2025-03-10",
          canonical: "OVERDUE",
          staffClosure: { closedBy: "nurse@example.org", closedAt: "2026-06-14T00:00:00Z", closedReason: "MANUAL_RESOLVE" },
        }}
      />,
    );
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    // The VISIBLE marker carries the clause, not only the hover title: a coordinator scanning a grid
    // reads the words on the chip, and "Closed by staff" alone would read as "dealt with".
    expect(screen.getByText(/Closed by staff . still counted/)).toBeInTheDocument();
    // …and the whole sentence, with who and when, is available to a screen reader and on hover.
    expect(screen.getByText(/Closed by nurse@example.org .* still counted by CQL/)).toBeInTheDocument();
  });

  it("shows no marker when nobody closed the case", () => {
    render(<ComplianceChip cell={{ status: "OVERDUE", method: "Last audiogram 2025-03-10", canonical: "OVERDUE" }} />);
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.queryByText(/Closed by staff/)).not.toBeInTheDocument();
    expect(screen.queryByText(/still counted/)).not.toBeInTheDocument();
  });

  it("renders IN_PROGRESS with its blue chip", () => {
    const { container } = render(<ComplianceChip cell={{ status: "IN_PROGRESS", method: "1 of 2 doses on file" }} />);
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(container.innerHTML).toContain("blue");
  });
});
