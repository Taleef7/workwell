import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

// A range IS set globally: the hierarchy must not send it (#699).
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "2026-09-21", to: "2026-09-28" }),
}));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));

import HierarchyPage from "../page";

const totals = (t: { compliant: number; dueSoon?: number; overdue: number; missingData?: number; excluded?: number; complianceRate: number | null }) => ({
  evaluated: 6,
  dueSoon: 0,
  missingData: 0,
  excluded: 0,
  openCases: 0,
  ...t,
});

// Two patients who both read "Evaluated 6 · Compliant 1": one is in two measures' populations, the
// other in four, so their rates are 50% and 25% (#643). Patient A's other four rows are one exclusion
// and three outside the population, none of which is in the population the rate divides by.
const tree = {
  level: "all",
  id: "all",
  name: "All Systems",
  parentId: null,
  totals: { ...totals({ compliant: 2, overdue: 4, complianceRate: 33.3 }), evaluated: 12 },
  children: [
    { level: "patient", id: "pat-a", name: "Patient A", parentId: "all", totals: { ...totals({ compliant: 1, overdue: 1, excluded: 1, complianceRate: 50 }), notInPopulation: 3 }, children: [] },
    { level: "patient", id: "pat-b", name: "Patient B", parentId: "all", totals: totals({ compliant: 1, overdue: 3, complianceRate: 25 }), children: [] },
  ],
};

const programs = [
  { measureId: "cms125", measureName: "Breast Cancer Screening", improvementNotation: "increase" },
  { measureId: "cms122", measureName: "Diabetes: Glycemic Status > 9%", improvementNotation: "decrease" },
];

const cells = (name: string): string[] => {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return within(row).getAllByRole("cell").map((c) => c.textContent?.trim() ?? "");
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((path: string) => {
    if (path.startsWith("/api/hierarchy/rollup")) return Promise.resolve(tree);
    if (path.startsWith("/api/programs/overview")) return Promise.resolve(programs);
    if (path === "/api/measures") {
      return Promise.resolve([{ id: "cms125", name: "Breast Cancer Screening", identity: { cmsId: "CMS125", mipsQualityId: "112" } }]);
    }
    return Promise.resolve([]);
  });
});
afterEach(() => vi.clearAllMocks());

describe("HierarchyPage — each row shows the numbers its rate is made of (#643)", () => {
  it("shows In population in place of Evaluated, so equal Evaluated/Compliant rows explain their different rates", async () => {
    render(<HierarchyPage />);
    await screen.findByText("Patient A");

    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Name", "In population", "Compliant", "Compliance", "Open Cases"]);

    expect(cells("Patient A").slice(1, 4)).toEqual(["2", "1", "50.0%"]);
    expect(cells("Patient B").slice(1, 4)).toEqual(["4", "1", "25.0%"]);
  });

  it("reads one lower-is-better measure as its Programs card does: poorly controlled over the same denominator", async () => {
    render(<HierarchyPage />);
    await screen.findByText("Patient B");
    await waitFor(() => expect(screen.getByRole("option", { name: /Glycemic/ })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Measure"), { target: { value: "cms122" } });
    await waitFor(() =>
      expect(get.mock.calls.some(([p]) => String(p).includes("measureId=cms122"))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
        "Name",
        "In population",
        "Poorly controlled",
        "Poor control",
        "Open Cases",
      ]),
    );
    // Patient B: 3 overdue of 4 in population = 75.0%, not the 25.0% compliance shown before.
    expect(cells("Patient B").slice(1, 4)).toEqual(["4", "3", "75.0%"]);
    expect(screen.getByText(/Lower is better/)).toBeInTheDocument();
  });

  it("names each measure in the filter by the label the Programs cards use (#648)", async () => {
    render(<HierarchyPage />);
    expect(await screen.findByRole("option", { name: "MIPS 112 · CMS125 · Breast Cancer Screening" })).toBeInTheDocument();
  });

  it("does not send the global date range: the rates are measurement-year figures (#699)", async () => {
    render(<HierarchyPage />);
    await screen.findByText("Patient A");
    const rollupCalls = get.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith("/api/hierarchy/rollup"));
    expect(rollupCalls.length).toBeGreaterThan(0);
    for (const url of rollupCalls) {
      expect(url).not.toMatch(/[?&](from|to)=/);
    }
  });
});
