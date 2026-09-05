import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MeasuresPage from "../page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/features/datavis/NitroGridClient", () => ({
  __esModule: true,
  default: ({ columns, rows, formatCell }: { columns?: Array<{ field: string; header: string }>; rows?: Array<Record<string, unknown>>; formatCell?: (val: unknown, row: unknown, col: unknown) => React.ReactNode }) => (
    <table>
      <thead>
        <tr>
          {columns?.map((col) => (
            <th key={col.field}>{col.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows?.map((row, i) => (
          <tr key={String(row.id ?? i)}>
            {columns?.map((col) => (
              <td key={col.field}>{formatCell ? formatCell(row[col.field], row, col) : (row[col.field] as React.ReactNode)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

const get = vi.fn();
const apiMock = { get, post: vi.fn() };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" }, token: "test-token", logout: vi.fn(), updateToken: vi.fn() }),
}));

const measure = (id: string, name: string, routing?: string) => ({
  id,
  name,
  policyRef: id === "audiogram" ? "OSHA 29 CFR 1910.95" : `CMS${id.replace("cms", "")}v1`,
  version: "v1.0",
  status: "Active",
  owner: "WorkWell Studio",
  lastUpdated: new Date().toISOString(),
  tags: [],
  statusUpdatedAt: new Date().toISOString(),
  statusUpdatedBy: "system",
  identity: null,
  routing,
});

describe("MeasuresPage routing badge", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue([
      measure("cms165", "Depression Screening", "official"),
      measure("cms125", "Breast Cancer Screening", "official-pending"),
      measure("audiogram", "Annual Audiogram Completed", "authored"),
    ]);
  });

  it("renders the official badge and the official-pending wording, and nothing for authored", async () => {
    render(<MeasuresPage />);
    expect(await screen.findByText("Depression Screening")).toBeInTheDocument();

    expect(screen.getByText("Official")).toBeInTheDocument();
    expect(screen.getByText("Official · not yet routed here")).toBeInTheDocument();

    const authoredRow = screen.getByText("Annual Audiogram Completed").closest("tr");
    expect(within(authoredRow!).queryByText("Official")).toBeNull();
    expect(within(authoredRow!).queryByText("Official · not yet routed here")).toBeNull();
  });
});
