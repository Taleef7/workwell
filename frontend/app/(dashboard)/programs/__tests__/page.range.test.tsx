import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
const filtersHolder = { value: { siteId: "", from: "", to: "" } };
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => filtersHolder.value,
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

import ProgramsPage from "../page";

const program = {
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125",
  version: "FHIR v1",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 10,
  compliant: 4,
  dueSoon: 0,
  overdue: 6,
  missingData: 0,
  excluded: 0,
  complianceRate: 40,
  openCaseCount: 6,
};

beforeEach(() => {
  filtersHolder.value = { siteId: "", from: "", to: "" };
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([program]);
    return Promise.resolve([]);
  });
});

describe("ProgramsPage — every number on a card describes one population (#699)", () => {
  it("never sends the global date range, so Open cases is not scoped apart from the chips beside it", async () => {
    filtersHolder.value = { siteId: "", from: "2026-09-21", to: "2026-09-28" };
    render(<ProgramsPage />);
    await screen.findByRole("link", { name: /overdue/i });
    const programCalls = () => get.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/programs/overview"));
    await waitFor(() => expect(programCalls()).toHaveLength(2));
    for (const url of programCalls()) {
      expect(url).not.toMatch(/[?&](from|to)=/);
    }
  });

  it("carries the site on the Open cases link, so Cases shows the count the card shows", async () => {
    filtersHolder.value = { siteId: "Kihei Clinic", from: "", to: "" };
    render(<ProgramsPage />);
    const link = await screen.findByRole("link", { name: "Open cases (6)" });
    expect(link).toHaveAttribute("href", "/cases?measureId=cms125&site=Kihei+Clinic");
  });

  it("links Open cases to the measure alone when no site is chosen", async () => {
    render(<ProgramsPage />);
    const link = await screen.findByRole("link", { name: "Open cases (6)" });
    expect(link).toHaveAttribute("href", "/cases?measureId=cms125");
  });
});
