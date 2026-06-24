import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CqlEvidence } from "./CqlEvidence";

describe("CqlEvidence", () => {
  it("renders non-internal defines and filters internal ones", () => {
    render(<CqlEvidence evidence={{ expressionResults: [
      { define: "Dose Count", result: 2 },
      { define: "Numerator", result: true },
      { define: "Outcome Status", result: "COMPLIANT" }
    ] }} />);
    expect(screen.getByText("Dose Count")).toBeInTheDocument();
    expect(screen.getByText("Outcome Status")).toBeInTheDocument();
    expect(screen.queryByText("Numerator")).not.toBeInTheDocument();
  });

  it("renders the why_flagged summary rows", () => {
    render(<CqlEvidence evidence={{ why_flagged: {
      last_exam_date: "2025-08-10", compliance_window_days: 365, days_overdue: 12,
      role_eligible: true, site_eligible: true, waiver_status: "NONE"
    } }} />);
    expect(screen.getByText("Last exam date")).toBeInTheDocument();
    expect(screen.getByText("2025-08-10")).toBeInTheDocument();
    expect(screen.getByText("Waiver status")).toBeInTheDocument();
  });

  it("shows a fallback when there is no evidence", () => {
    render(<CqlEvidence evidence={null} />);
    expect(screen.getByText("No evidence recorded.")).toBeInTheDocument();
  });
});
