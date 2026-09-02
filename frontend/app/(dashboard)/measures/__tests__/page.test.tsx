import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MeasuresPage from "../page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/features/datavis/NitroGridClient", () => ({
  __esModule: true,
  default: ({ columns, rows, data, formatCell }: { columns?: Array<{ field: string; header: string }>; rows?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>>; formatCell?: (val: unknown, row: unknown, col: unknown) => React.ReactNode }) => {
    const rowList = rows ?? data ?? [];
    return (
      <table>
        <thead>
          <tr>
            {columns?.map((col) => (
              <th key={col.field ?? col.header}>{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowList.map((row, i) => (
            <tr key={String(row.id ?? i)}>
              {columns?.map((col) => (
                <td key={col.field}>
                  {formatCell ? formatCell(row[col.field], row, col) : (row[col.field] as React.ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
}));

const get = vi.fn();
const post = vi.fn();
const apiMock = { get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const authValue = { user: { role: "ROLE_ADMIN" }, token: "test-token", logout: vi.fn(), updateToken: vi.fn() };
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => authValue,
}));

describe("MeasuresPage crosswalk identity rendering", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue([
      {
        id: "cms125",
        name: "Breast Cancer Screening",
        policyRef: "CMS125v14",
        version: "v1.0",
        status: "Active",
        owner: "WorkWell Studio",
        lastUpdated: new Date().toISOString(),
        tags: ["ecqm"],
        statusUpdatedAt: new Date().toISOString(),
        statusUpdatedBy: "system",
        identity: { cmsId: "CMS125", mipsQualityId: "112" },
      },
      {
        id: "audiogram",
        name: "Annual Audiogram Completed",
        policyRef: "OSHA 29 CFR 1910.95",
        version: "v1.0",
        status: "Active",
        owner: "system",
        lastUpdated: new Date().toISOString(),
        tags: ["osha"],
        statusUpdatedAt: new Date().toISOString(),
        statusUpdatedBy: "system",
        identity: null,
      },
    ]);
  });

  it("renders the Identity column with MIPS 112 · CMS125 for cms125 and dash for audiogram", async () => {
    render(<MeasuresPage />);
    expect(await screen.findByText("Measures")).toBeInTheDocument();

    // Verify Identity column header is present
    expect(await screen.findByText("Identity")).toBeInTheDocument();

    // Verify MIPS 112 · CMS125 text is rendered for cms125
    await waitFor(() => {
      expect(screen.getByText("MIPS 112 · CMS125")).toBeInTheDocument();
    });

    // Verify dash for OSHA measure is rendered
    const row = screen.getByText("Annual Audiogram Completed").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("—")).toBeInTheDocument();
  });
});
