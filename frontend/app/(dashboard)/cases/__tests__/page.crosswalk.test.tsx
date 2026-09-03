import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
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
    evaluationPeriod: "2026-01-01",
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
    setSubject("employee");
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

  it("renders crosswalk label MIPS 112 · CMS125 · Breast Cancer Screening for cms125 case and plain name for audiogram in cards and table views", async () => {
    render(<CasesPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Alice Walker" })).toBeInTheDocument();
    });

    // 1. Cards view (default): assert CMS label and OSHA plain name inside the respective cards
    const aliceCard = screen.getByRole("heading", { name: "Alice Walker" }).closest<HTMLElement>("div.rounded-2xl")!;
    expect(aliceCard).toBeInTheDocument();
    expect(within(aliceCard).getByText("MIPS 112 · CMS125 · Breast Cancer Screening")).toBeInTheDocument();

    const bobCard = screen.getByRole("heading", { name: "Bob Builder" }).closest<HTMLElement>("div.rounded-2xl")!;
    expect(bobCard).toBeInTheDocument();
    expect(within(bobCard).getByText("Annual Audiogram Completed", { exact: true })).toBeInTheDocument();
    expect(within(bobCard).queryByText(/^MIPS/)).not.toBeInTheDocument();

    // 2. Switch to table view: click the 'table' view button
    fireEvent.click(screen.getByRole("button", { name: "table" }));

    // Assert inside the table cells for each row
    const aliceLink = screen.getByRole("link", { name: "Alice Walker" });
    const aliceRow = aliceLink.closest<HTMLTableRowElement>("tr")!;
    expect(aliceRow).toBeInTheDocument();
    const cmsCell = within(aliceRow).getByText("MIPS 112 · CMS125 · Breast Cancer Screening");
    expect(cmsCell).toBeInTheDocument();
    expect(cmsCell.tagName).toBe("TD");

    const bobLink = screen.getByRole("link", { name: "Bob Builder" });
    const bobRow = bobLink.closest<HTMLTableRowElement>("tr")!;
    expect(bobRow).toBeInTheDocument();
    const oshaCell = within(bobRow).getByText("Annual Audiogram Completed", { exact: true });
    expect(oshaCell).toBeInTheDocument();
    expect(oshaCell.tagName).toBe("TD");
    expect(within(bobRow).queryByText(/^MIPS/)).not.toBeInTheDocument();
  });

  it("labels evaluation periods as measurement years and preserves non-year values", async () => {
    setSubject("patient");
    render(<CasesPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Alice Walker" })).toBeInTheDocument();
    });

    const aliceCard = screen.getByRole("heading", { name: "Alice Walker" }).closest<HTMLElement>("div.rounded-2xl")!;
    const bobCard = screen.getByRole("heading", { name: "Bob Builder" }).closest<HTMLElement>("div.rounded-2xl")!;
    expect(within(aliceCard).getByText("Measurement year")).toBeInTheDocument();
    expect(within(aliceCard).getByText("2026", { exact: true })).toBeInTheDocument();
    expect(within(aliceCard).queryByText("2026-01-01", { exact: true })).not.toBeInTheDocument();
    expect(within(bobCard).getByText("Measurement year")).toBeInTheDocument();
    expect(within(bobCard).getByText("2026-Q1", { exact: true })).toBeInTheDocument();
  });

  it("keeps raw periods and the Period label for employees", async () => {
    setSubject("employee");
    render(<CasesPage />);
    await screen.findByRole("heading", { name: "Alice Walker" });

    const aliceCard = screen.getByRole("heading", { name: "Alice Walker" }).closest<HTMLElement>("div.rounded-2xl")!;
    expect(within(aliceCard).getByText("Period")).toBeInTheDocument();
    expect(within(aliceCard).getByText("2026-01-01", { exact: true })).toBeInTheDocument();
    expect(within(aliceCard).queryByText("Measurement year")).not.toBeInTheDocument();
  });

  it("uses exclusion copy for patients and keeps waiver copy for employees", async () => {
    setSubject("patient");
    getWithHeaders.mockImplementation(() => Promise.resolve({
      data: [{
        ...mockCases[0],
        status: "EXCLUDED",
        currentOutcomeStatus: "EXCLUDED",
        exclusionReason: null,
      }],
      headers: new Headers({ "X-Total-Count": "1" }),
    }));

    const { unmount } = render(<CasesPage />);
    await screen.findByRole("heading", { name: "Alice Walker" });
    expect(screen.getByText("Exclusion", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Excluded by a documented exclusion.", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Waiver", { selector: "dt" })).not.toBeInTheDocument();

    unmount();
    setSubject("employee");
    getWithHeaders.mockImplementation(() => Promise.resolve({
      data: [{
        ...mockCases[0],
        status: "EXCLUDED",
        currentOutcomeStatus: "EXCLUDED",
        exclusionReason: null,
      }],
      headers: new Headers({ "X-Total-Count": "1" }),
    }));
    render(<CasesPage />);
    await screen.findByRole("heading", { name: "Alice Walker" });
    expect(screen.getByText("Waiver", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Excluded by active waiver or exemption.", { exact: true })).toBeInTheDocument();
  });

  it.each([
    ["patient", /including exclusion context when an exclusion applies/],
    ["employee", /including waiver context when an exclusion applies/],
  ] as const)("uses %s terminology in the cases hero", async (term, copy) => {
    setSubject(term);
    render(<CasesPage />);
    await screen.findByRole("heading", { name: "Alice Walker" });
    expect(screen.getByRole("heading", { name: "Why Flagged cases" }).parentElement).toHaveTextContent(copy);
  });
});
