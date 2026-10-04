/**
 * An officially routed measure runs CMS's FHIR artifact, so the catalog grid names THAT logic and its
 * version, and shows the QDM measure only as what it was derived from (locked decision §4.3). The
 * identity chip ("MIPS 112 · CMS125") is unchanged.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MeasuresPage from "../page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/features/datavis/NitroGridClient", () => ({
  __esModule: true,
  default: ({ columns, rows, formatCell }: { columns?: Array<{ field: string; header: string; visible?: boolean }>; rows?: Array<Record<string, unknown>>; formatCell?: (val: unknown, row: unknown, col: unknown) => React.ReactNode }) => {
    const shown = (columns ?? []).filter((c) => c.visible !== false);
    return (
      <table>
        <thead>
          <tr>{shown.map((col) => <th key={col.field}>{col.header}</th>)}</tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row, i) => (
            <tr key={String(row.id ?? i)} data-translation={String(row.translation ?? "")}>
              {shown.map((col) => (
                <td key={col.field} data-field={col.field}>
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
const apiMock = { get, post: vi.fn() };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" }, token: "test-token", logout: vi.fn(), updateToken: vi.fn() }),
}));

const EXECUTED = {
  ecqmId: "CMS125FHIR",
  version: "1.0.000",
  status: "draft",
  statusNote: "posted for public comment Jan–Feb 2026",
  derivedFrom: "CMS125v14",
};

const row = (id: string, name: string, routing: string, policyRef: string, executed?: typeof EXECUTED) => ({
  id,
  name,
  policyRef,
  version: "v1.0",
  status: "Active",
  owner: "WorkWell Studio",
  lastUpdated: new Date().toISOString(),
  tags: [],
  statusUpdatedAt: new Date().toISOString(),
  statusUpdatedBy: "system",
  identity: policyRef.startsWith("CMS") ? { cmsId: policyRef.replace(/v\d+$/, ""), mipsQualityId: "112", ...(executed ? { executed } : {}) } : null,
  routing,
});

const cell = (rowName: string, field: string) => {
  const tr = screen.getByText(rowName).closest("tr")!;
  return tr.querySelector(`td[data-field="${field}"]`) as HTMLElement;
};

describe("MeasuresPage executed logic", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue([
      row("cms125", "Breast Cancer Screening", "official", "CMS125v14", EXECUTED),
      row("cms130", "Colorectal Cancer Screening", "authored", "CMS130v14"),
      row("audiogram", "Annual Audiogram Completed", "authored", "OSHA 29 CFR 1910.95"),
    ]);
  });

  it("shows the executed artifact's version, not the catalog's, for an official measure", async () => {
    render(<MeasuresPage />);
    await screen.findByText("Breast Cancer Screening");
    expect(cell("Breast Cancer Screening", "version")).toHaveTextContent(/^1\.0\.000$/);
    expect(cell("Colorectal Cancer Screening", "version")).toHaveTextContent(/^v1\.0$/);
    expect(cell("Annual Audiogram Completed", "version")).toHaveTextContent(/^v1\.0$/);
  });

  it("names the executed artifact in Policy Ref and the QDM measure only as its source", async () => {
    render(<MeasuresPage />);
    await screen.findByText("Breast Cancer Screening");
    const ref = cell("Breast Cancer Screening", "policyRef");
    expect(within(ref).getByText("CMS125FHIR")).toBeInTheDocument();
    expect(within(ref).getByText("derived from CMS125v14")).toBeInTheDocument();
    // Never the QDM id on its own, as if it were what ran.
    expect(within(ref).queryByText("CMS125v14")).toBeNull();
    // The identity chip text is unchanged (it is pinned across the app).
    expect(cell("Breast Cancer Screening", "identity")).toHaveTextContent(/^MIPS 112 · CMS125$/);
    // An authored measure keeps its policy reference.
    expect(within(cell("Colorectal Cancer Screening", "policyRef")).getByText("CMS130v14")).toBeInTheDocument();
  });

  it("badges a routed WorkWell translation with its year, beside CMS's artifact, and only on an official row", async () => {
    const translation = { label: "WorkWell translation of CMS125v15", version: "ww-2027.1", url: "urn:workwell:measure:cms125:translation", derivedFrom: "CMS125v15", year: "2027" };
    const withTranslation = (routing: string) => {
      const r = row("cms125", "Breast Cancer Screening", routing, "CMS125v14", EXECUTED);
      return { ...r, identity: { ...r.identity!, translation } };
    };
    get.mockReset().mockResolvedValue([withTranslation("official")]);
    const view = render(<MeasuresPage />);
    await screen.findByText("Breast Cancer Screening");
    const ref = cell("Breast Cancer Screening", "policyRef");
    expect(within(ref).getByTestId("measure-translation-badge")).toHaveTextContent("2027: WorkWell translation of CMS125v15");
    expect(within(ref).getByText("CMS125FHIR")).toBeInTheDocument();
    expect(cell("Breast Cancer Screening", "version")).toHaveTextContent(/^1\.0\.000$/);
    view.unmount();

    get.mockReset().mockResolvedValue([withTranslation("official-pending")]);
    render(<MeasuresPage />);
    await screen.findByText("Breast Cancer Screening");
    expect(screen.queryByTestId("measure-translation-badge")).toBeNull();
    // Not even in the hidden Translation column: a measure not routed here runs neither logic.
    expect(screen.getByText("Breast Cancer Screening").closest("tr")).toHaveAttribute("data-translation", "");
  });

  it("does not trust an `executed` block on a measure that is not routed here", async () => {
    get.mockReset().mockResolvedValue([row("cms125", "Breast Cancer Screening", "official-pending", "CMS125v14", EXECUTED)]);
    render(<MeasuresPage />);
    await screen.findByText("Breast Cancer Screening");
    expect(cell("Breast Cancer Screening", "version")).toHaveTextContent(/^v1\.0$/);
    expect(within(cell("Breast Cancer Screening", "policyRef")).getByText("CMS125v14")).toBeInTheDocument();
  });
});
