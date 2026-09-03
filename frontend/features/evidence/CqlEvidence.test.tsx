import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import { CqlEvidence } from "./CqlEvidence";

describe("CqlEvidence", () => {
  beforeEach(() => {
    setSubject("employee");
  });
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
    expect(screen.getByText("Role eligible")).toBeInTheDocument();
    expect(screen.getByText("Site eligible")).toBeInTheDocument();
    expect(screen.getByText("Waiver status")).toBeInTheDocument();
  });

  it("hides occupational rows and labels exclusion status for patients", () => {
    setSubject("patient");
    render(<CqlEvidence evidence={{ why_flagged: {
      last_exam_date: "2025-08-10", compliance_window_days: 365, days_overdue: 12,
      role_eligible: true, site_eligible: true, waiver_status: "NONE"
    } }} />);
    expect(screen.queryByText("Role eligible")).not.toBeInTheDocument();
    expect(screen.queryByText("Site eligible")).not.toBeInTheDocument();
    expect(screen.getByText("Last result date")).toBeInTheDocument();
    expect(screen.queryByText("Last exam date")).not.toBeInTheDocument();
    expect(screen.getByText("Exclusion status")).toBeInTheDocument();
  });

  it("shows a fallback when there is no evidence", () => {
    render(<CqlEvidence evidence={null} />);
    expect(screen.getByText("No evidence recorded.")).toBeInTheDocument();
  });
});
