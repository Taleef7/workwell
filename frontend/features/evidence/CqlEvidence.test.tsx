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

  it("renders a multi-rate measure's populations under their rate label", () => {
    setSubject("patient");
    render(<CqlEvidence evidence={{ expressionResults: [
      { define: "official:Initiation:numerator", result: true },
      { define: "official:Engagement:numerator", result: false },
    ] }} />);
    expect(screen.getByText("Initiation · Numerator")).toBeInTheDocument();
    expect(screen.getByText("Engagement · Numerator")).toBeInTheDocument();
    expect(screen.getByText("in")).toBeInTheDocument();
    expect(screen.getByText("not in")).toBeInTheDocument();
  });

  it("renders the official why-flagged summary when the backend derived one", () => {
    setSubject("patient");
    render(<CqlEvidence evidence={{ why_flagged: {
      last_exam_date: null, compliance_window_days: 365, days_overdue: null,
      role_eligible: true, site_eligible: true, waiver_status: "none",
      official_summary: "Flagged: treatment was initiated within 14 days but not engaged within 34 days of initiation.",
    } }} />);
    expect(screen.getByText("Why flagged")).toBeInTheDocument();
    expect(screen.getByText(/treatment was initiated within 14 days but not engaged/)).toBeInTheDocument();
  });
});
