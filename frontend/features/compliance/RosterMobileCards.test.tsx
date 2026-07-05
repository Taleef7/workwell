import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { RosterMobileCards } from "./RosterMobileCards";
import type { RosterColumn, RosterRow } from "./types";

const columns: RosterColumn[] = [
  { measureId: "mmr", name: "MMR", complianceClass: "PERMANENT" },
  { measureId: "varicella", name: "Varicella", complianceClass: "PERMANENT" },
];
const rows: RosterRow[] = [
  {
    subject: { externalId: "emp-006", name: "Ada Lovelace", role: "Nurse", site: "HQ", tenantId: "twh", tenantName: "Total Worker Health" },
    cells: {
      mmr: { status: "COMPLIANT", method: "2 valid dose(s)" },
      // varicella intentionally omitted → NA fallback
    },
  },
];

describe("RosterMobileCards", () => {
  it("renders a card per employee with a name link and context subtext", () => {
    render(<RosterMobileCards columns={columns} rows={rows} loading={false} />);
    const link = screen.getByRole("link", { name: "Ada Lovelace" });
    expect(link).toHaveAttribute("href", "/employees/emp-006");
    expect(screen.getByText(/Total Worker Health/)).toBeInTheDocument();
    expect(screen.getByText(/HQ/)).toBeInTheDocument();
    expect(screen.getByText(/Nurse/)).toBeInTheDocument();
  });

  it("renders a chip per column and falls back to NA for a missing cell", () => {
    render(<RosterMobileCards columns={columns} rows={rows} loading={false} />);
    // MMR cell present
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(screen.getByText("2 valid dose(s)")).toBeInTheDocument();
    // varicella missing → NA fallback method text (rendered by ComplianceChip's sr-only detail)
    expect(screen.getByText(/Not evaluated/)).toBeInTheDocument();
    // both measure names appear as <dt> labels (regex — the <dt> also holds a perm/rec span,
    // so exact-match on "MMR" would miss the combined "MMR perm" text content)
    expect(screen.getByText(/^MMR/)).toBeInTheDocument();
    expect(screen.getByText(/^Varicella/)).toBeInTheDocument();
  });

  it("shows a loading state with no rows, and an empty state otherwise", () => {
    const { rerender } = render(<RosterMobileCards columns={columns} rows={[]} loading={true} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    rerender(<RosterMobileCards columns={columns} rows={[]} loading={false} />);
    expect(screen.getByText("No employees match these filters.")).toBeInTheDocument();
  });
});
