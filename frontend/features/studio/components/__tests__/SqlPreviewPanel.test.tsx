import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SqlPreviewPanel } from "../SqlPreviewPanel";
import type { MeasureDetail } from "../../types";

const sampleMeasure: MeasureDetail = {
  id: "m1",
  name: "Annual Audiogram Completed",
  policyRef: "OSHA 29 CFR 1910.95",
  oshaReferenceId: null,
  version: "1.0",
  status: "Active",
  owner: "Safety",
  description: "Annual audiogram for employees in hearing conservation.",
  eligibilityCriteria: {
    roleFilter: "Safety Technician",
    siteFilter: "Plant A",
    programEnrollmentText: "In Hearing Conservation Program",
  },
  exclusions: [{ label: "Active Waiver", criteriaText: "Has Active Waiver" }],
  complianceWindow: "365 days",
  requiredDataElements: ["Audiogram Date", "Waiver Status"],
  cqlText: "",
  compileStatus: "COMPILED",
  valueSets: [],
  testFixtures: [],
};

describe("SqlPreviewPanel", () => {
  it("renders a collapsed toggle button by default", () => {
    render(<SqlPreviewPanel measure={sampleMeasure} />);
    expect(screen.getByRole("button", { name: /SQL Analogy/i })).toBeInTheDocument();
    expect(screen.queryByTestId("sql-preview-block")).toBeNull();
  });

  it("expands and shows the illustrative-only banner on click", () => {
    render(<SqlPreviewPanel measure={sampleMeasure} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL Analogy/i }));
    // The amber banner span uses exact text "Illustrative only"
    expect(screen.getAllByText(/Illustrative only/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Not executed\. CQL is the compliance source of truth/i)).toBeInTheDocument();
  });

  it("shows policy ref and compliance window in the SQL block", () => {
    render(<SqlPreviewPanel measure={sampleMeasure} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL Analogy/i }));
    const block = screen.getByTestId("sql-preview-block");
    expect(block.textContent).toContain("OSHA 29 CFR 1910.95");
    expect(block.textContent).toContain("365 days");
    expect(block.textContent).toContain("335 days");
  });

  it("includes role and site filters from spec", () => {
    render(<SqlPreviewPanel measure={sampleMeasure} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL Analogy/i }));
    const block = screen.getByTestId("sql-preview-block");
    expect(block.textContent).toContain("Safety Technician");
    expect(block.textContent).toContain("Plant A");
  });

  it("includes the approximate DUE_SOON comment", () => {
    render(<SqlPreviewPanel measure={sampleMeasure} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL Analogy/i }));
    const block = screen.getByTestId("sql-preview-block");
    expect(block.textContent).toContain("DUE_SOON threshold approximate; see CQL for exact window");
  });

  it("collapses again on second click", () => {
    render(<SqlPreviewPanel measure={sampleMeasure} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL Analogy/i }));
    fireEvent.click(screen.getByRole("button", { name: /SQL Analogy/i }));
    expect(screen.queryByTestId("sql-preview-block")).toBeNull();
  });

  it("renders fallback text when compliance window has no numeric value", () => {
    const noWindow: MeasureDetail = { ...sampleMeasure, complianceWindow: "see policy" };
    render(<SqlPreviewPanel measure={noWindow} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL Analogy/i }));
    const block = screen.getByTestId("sql-preview-block");
    expect(block.textContent).toContain("see policy");
  });
});
