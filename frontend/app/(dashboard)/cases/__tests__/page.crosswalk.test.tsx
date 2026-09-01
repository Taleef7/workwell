import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CasesPage from "../page";

const getWithHeaders = vi.fn();
const get = vi.fn();
const apiMock = { getWithHeaders, get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/cases",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN", email: "admin@example.com" } }),
}));

const mockCases = [
  {
    caseId: "case-001",
    employeeId: "emp-101",
    employeeName: "Alice Walker",
    site: "Plant A",
    measureId: "cms125",
    measureVersionId: "cms125",
    measureName: "Breast Cancer Screening",
    measureVersion: "1.0",
    evaluationPeriod: "2026-Q1",
    status: "OPEN",
    priority: "HIGH",
    assignee: null,
    currentOutcomeStatus: "OVERDUE",
    lastRunId: "run-001",
    exclusionReason: null,
    waiverExpiresAt: null,
    waiverExpired: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    caseId: "case-002",
    employeeId: "emp-102",
    employeeName: "Bob Builder",
    site: "Plant B",
    measureId: "audiogram",
    measureVersionId: "audiogram",
    measureName: "Annual Audiogram Completed",
    measureVersion: "1.0",
    evaluationPeriod: "2026-Q1",
    status: "OPEN",
    priority: "HIGH",
    assignee: null,
    currentOutcomeStatus: "OVERDUE",
    lastRunId: "run-001",
    exclusionReason: null,
    waiverExpiresAt: null,
    waiverExpired: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("CasesPage crosswalk identity rendering", () => {
  beforeEach(() => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "cms125",
            name: "Breast Cancer Screening",
            status: "Active",
            identity: { cmsId: "CMS125", mipsQualityId: "112" },
          },
          {
            id: "audiogram",
            name: "Annual Audiogram Completed",
            status: "Active",
            identity: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    getWithHeaders.mockImplementation((url: string) => {
      if (String(url).startsWith("/api/cases")) {
        return Promise.resolve({
          data: mockCases,
          headers: new Headers({ "X-Total-Count": "2" }),
        });
      }
      return Promise.resolve({
        data: [],
        headers: new Headers({ "X-Total-Count": "0" }),
      });
    });
  });

  it("renders crosswalk label MIPS 112 · CMS125 · Breast Cancer Screening for cms125 case and plain name for audiogram", async () => {
    render(<CasesPage />);
    await waitFor(() => {
      const elements = screen.getAllByText("MIPS 112 · CMS125 · Breast Cancer Screening");
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });

    const audiogramElements = screen.getAllByText("Annual Audiogram Completed", { exact: true });
    expect(audiogramElements.length).toBeGreaterThanOrEqual(1);
  });
});
