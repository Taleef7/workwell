import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import CasesPage from "../page";
import { CMS125_ARTIFACT, CMS137_TRANSLATION, LABELS, ROUTED_IDENTITIES } from "@/test/fixtures/scoring-logic";

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

  it("names the logic that scored each case's outcome, in the cards and the table, never today's routing (#769)", async () => {
    // Routing says CMS's artifact runs both. Alice's row names CMS's artifact, Carol's the translation,
    // Dan's nothing: only Alice and Carol carry a version, each its own row's.
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          { id: "cms125", name: "Breast Cancer Screening", status: "Active", identity: ROUTED_IDENTITIES.cms125 },
          { id: "cms137", name: "Substance Use Treatment", status: "Active", identity: ROUTED_IDENTITIES.cms137 },
        ]);
      }
      return Promise.resolve([]);
    });
    getWithHeaders.mockImplementation(() => Promise.resolve({
      data: [
        { ...mockCases[0], logic: CMS125_ARTIFACT },
        { ...mockCases[0], caseId: "case-137", employeeId: "emp-103", employeeName: "Carol Diaz", measureId: "cms137", measureVersionId: "cms137", measureName: "Substance Use Treatment", logic: CMS137_TRANSLATION },
        { ...mockCases[0], caseId: "case-125b", employeeId: "emp-104", employeeName: "Dan Ito", logic: null },
      ],
      headers: new Headers({ "X-Total-Count": "3" }),
    }));
    render(<CasesPage />);
    await screen.findByRole("heading", { name: "Carol Diaz" });

    const card = (name: string) => screen.getByRole("heading", { name }).closest<HTMLElement>("div.rounded-2xl")!;
    const alice = within(card("Alice Walker")).getByText(`${LABELS.cms125Short} · Breast Cancer Screening`, { exact: true });
    expect(alice).toHaveAttribute("title", `${LABELS.cms125Title} · Breast Cancer Screening`);
    const carol = within(card("Carol Diaz")).getByText(`${LABELS.cms137TranslationShort} · Substance Use Treatment`, { exact: true });
    expect(carol).toHaveAttribute("title", `${LABELS.cms137TranslationTitle} · Substance Use Treatment`);
    expect(within(card("Carol Diaz")).queryByText(/FHIR/)).toBeNull();
    // No row logic: unversioned, though routing names an executed artifact.
    expect(within(card("Dan Ito")).getByText(`${LABELS.cms125Plain} · Breast Cancer Screening`, { exact: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "table" }));
    const row = (name: string) => screen.getByRole("link", { name }).closest<HTMLTableRowElement>("tr")!;
    const aliceCell = within(row("Alice Walker")).getByText(`${LABELS.cms125Short} · Breast Cancer Screening`, { exact: true });
    expect(aliceCell.tagName).toBe("TD");
    expect(aliceCell).toHaveAttribute("title", `${LABELS.cms125Title} · Breast Cancer Screening`);
    expect(within(row("Carol Diaz")).getByText(`${LABELS.cms137TranslationShort} · Substance Use Treatment`, { exact: true }).tagName).toBe("TD");
    expect(within(row("Dan Ito")).getByText(`${LABELS.cms125Plain} · Breast Cancer Screening`, { exact: true }).tagName).toBe("TD");

    // The Measure filter selects a measure across years: unversioned.
    await userEvent.click(screen.getByRole("combobox", { name: /measure/i }));
    expect(await screen.findByRole("option", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: `${LABELS.cms137Plain} · Substance Use Treatment` })).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "Cases" }).parentElement).toHaveTextContent(copy);
  });

  it("offers each measure in the Measure filter by the label the cards use (#648)", async () => {
    render(<CasesPage />);
    await screen.findByRole("heading", { name: "Alice Walker" });
    await userEvent.click(screen.getByRole("combobox", { name: /measure/i }));
    expect(await screen.findByRole("option", { name: "MIPS 112 · CMS125 · Breast Cancer Screening" })).toBeInTheDocument();
    // A measure with no published identity keeps its plain name.
    expect(screen.getByRole("option", { name: "Annual Audiogram Completed" })).toBeInTheDocument();
  });

  it("links a patient to /patients/<id> on a patient deployment (#648)", async () => {
    setSubject("patient");
    render(<CasesPage />);
    const heading = await screen.findByRole("heading", { name: "Alice Walker" });
    // The card's name opens the patient's page (the table's opens the case).
    expect(within(heading).getByRole("link", { name: "Alice Walker" })).toHaveAttribute("href", "/patients/emp-101");
  });

  it("shows the cards on a phone even in table view, with bulk selection (#700)", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("48rem"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      render(<CasesPage />);
      await screen.findByRole("heading", { name: "Alice Walker" });
      fireEvent.click(screen.getByRole("button", { name: "table" }));
      // The table is md+; a phone keeps the cards, whose checkboxes are its bulk selection.
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.getByRole("heading", { name: "Alice Walker" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Select Alice Walker" })).toBeInTheDocument();
      const selectAll = screen.getByText("Select all in current results").closest("label")!;
      expect(selectAll).toHaveClass("flex");
      expect(selectAll).not.toHaveClass("hidden");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers no separate phone list: one card, one link per case", async () => {
    render(<CasesPage />);
    await screen.findByRole("heading", { name: "Alice Walker" });
    // The old phone list linked each case a second time under the patient's name and measure.
    expect(screen.getAllByRole("link", { name: /Alice Walker/ })).toHaveLength(1);
  });
});
