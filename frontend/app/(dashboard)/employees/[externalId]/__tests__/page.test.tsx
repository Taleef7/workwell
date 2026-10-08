import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import EmployeeProfilePage from "../page";
import { CMS125_ARTIFACT, CMS137_TRANSLATION, LABELS, ROUTED_IDENTITIES } from "@/test/fixtures/scoring-logic";

const get = vi.fn();
const post = vi.fn();
const apiMock = { get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

// The page reads the signed-in role to decide whether the per-gap assign control is editable (#553).
// In the app it is always inside AuthProvider; here the provider is mocked rather than rendered,
// because these tests are about what the page shows, not about how a session is established.
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: "cm@workwell.dev" } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ externalId: "emp-001" }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/features/employee/components/IndividualComplianceStatus", () => ({
  IndividualComplianceStatus: () => <div data-testid="individual-compliance-status" />,
}));
vi.mock("@/features/employee/components/SimulateComplianceHistory", () => ({
  SimulateComplianceHistory: () => <div data-testid="simulate-compliance-history" />,
}));

const mockProfile = {
  id: "emp-001",
  externalId: "emp-001",
  name: "Jane Doe",
  role: "Engineer",
  site: "Plant A",
  supervisorName: "Manager Smith",
  startDate: null,
  fhirPatientId: null,
  active: true,
  measureOutcomes: [
    {
      measureId: "cms125",
      measureVersionId: "cms125",
      measureName: "Breast Cancer Screening",
      measureVersion: "v1.0",
      outcomeStatus: "OVERDUE",
      lastRunDate: "2026-01-01T00:00:00Z",
      daysSinceLastExam: null,
      daysUntilDue: null,
      openCaseId: "case-001",
    },
    {
      measureId: "audiogram",
      measureVersionId: "audiogram",
      measureName: "Annual Audiogram Completed",
      measureVersion: "v1.0",
      outcomeStatus: "COMPLIANT",
      lastRunDate: "2026-01-01T00:00:00Z",
      daysSinceLastExam: 100,
      daysUntilDue: 265,
      openCaseId: null,
    },
  ],
  openCases: [
    {
      caseId: "case-001",
      measureId: "cms125",
      measureName: "Breast Cancer Screening",
      outcomeStatus: "OVERDUE",
      priority: "HIGH",
      assignee: "cm@workwell.dev",
      slaDueDate: null,
    },
  ],
  recentAuditEvents: [],
};

describe("EmployeeProfilePage crosswalk identity rendering", () => {
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
      if (url === "/api/employees/emp-001/profile") {
        return Promise.resolve(mockProfile);
      }
      return Promise.resolve([]);
    });
  });

  it("renders crosswalk label for cms125 outcome row and plain name for audiogram", async () => {
    render(<EmployeeProfilePage />);
    await waitFor(() => expect(screen.getByText("Compliance Posture")).toBeInTheDocument());

    const summaryBar = screen.getByText("Compliance Posture").parentElement!;
    expect(within(summaryBar).getByText(
      "MIPS 112 · CMS125 · Breast Cancer Screening — Overdue",
      { exact: true },
    )).toBeInTheDocument();
    expect(within(summaryBar).getByText("Annual Audiogram Completed — Compliant", { exact: true })).toBeInTheDocument();

    // Open-case row: assert CMS label on the open-case link/row (page.tsx ~110)
    const openCaseLink = screen.getByRole("link", { name: "MIPS 112 · CMS125 · Breast Cancer Screening" });
    expect(openCaseLink).toHaveAttribute("href", "/cases/case-001");
    const openCaseRow = openCaseLink.closest<HTMLTableRowElement>("tr")!;
    expect(within(openCaseRow).getByText("MIPS 112 · CMS125 · Breast Cancer Screening", { exact: true })).toBeInTheDocument();

    // CMS measure-detail row (page.tsx ~151)
    const cmsOutcomeRow = document.getElementById("measure-cms125")!;
    expect(within(cmsOutcomeRow).getByText("MIPS 112 · CMS125 · Breast Cancer Screening", { exact: true })).toBeInTheDocument();

    // OSHA measure-detail row
    const oshaOutcomeRow = document.getElementById("measure-audiogram")!;
    expect(within(oshaOutcomeRow).getByText("Annual Audiogram Completed", { exact: true })).toBeInTheDocument();
    expect(within(oshaOutcomeRow).queryByText(/^MIPS/)).not.toBeInTheDocument();
  });

  describe("names the logic that scored each result, never today's routing (#769)", () => {
    // Routing (identity.executed) names CMS's artifact for both CMS measures. The rows say: cms125 by
    // CMS's artifact, cms137 by the translation. The served version is the authored "2.0.0" an older
    // server printed beside a CMS-scored row; it must not be shown beside a row that names its logic.
    let servedVersion = "2.0.0";
    const outcome = (over: Record<string, unknown>) => ({ ...mockProfile.measureOutcomes[0]!, measureVersion: servedVersion, ...over });
    function withRows(cms125Logic: unknown, cms137Logic: unknown, version = "2.0.0") {
      servedVersion = version;
      get.mockImplementation((url: string) => {
        if (url === "/api/measures") {
          return Promise.resolve([
            { id: "cms125", name: "Breast Cancer Screening", status: "Active", identity: ROUTED_IDENTITIES.cms125 },
            { id: "cms137", name: "Substance Use Treatment", status: "Active", identity: ROUTED_IDENTITIES.cms137 },
            { id: "audiogram", name: "Annual Audiogram Completed", status: "Active", identity: null },
          ]);
        }
        if (url === "/api/employees/emp-001/profile") {
          return Promise.resolve({
            ...mockProfile,
            measureOutcomes: [
              outcome({ logic: cms125Logic }),
              outcome({ measureId: "cms137", measureVersionId: "cms137", measureName: "Substance Use Treatment", openCaseId: "case-137", logic: cms137Logic }),
              mockProfile.measureOutcomes[1],
            ],
            openCases: [
              { ...mockProfile.openCases[0], logic: cms125Logic },
              { ...mockProfile.openCases[0], caseId: "case-137", measureId: "cms137", measureName: "Substance Use Treatment", logic: cms137Logic },
            ],
          });
        }
        return Promise.resolve([]);
      });
    }

    it("Measure Details: the full form; summary bar and open cases: the chip form, the full form as title", async () => {
      withRows(CMS125_ARTIFACT, CMS137_TRANSLATION);
      render(<EmployeeProfilePage />);
      const details125 = await waitFor(() => {
        const row = document.getElementById("measure-cms125");
        expect(row).not.toBeNull();
        return row!;
      });
      const full125 = await within(details125).findByText(`${LABELS.cms125Full} · Breast Cancer Screening`, { exact: true });
      expect(full125.parentElement).toHaveAttribute("title", `${LABELS.cms125Title} · Breast Cancer Screening`);
      const details137 = document.getElementById("measure-cms137")!;
      expect(within(details137).getByText(`${LABELS.cms137TranslationFull} · Substance Use Treatment`, { exact: true })).toBeInTheDocument();
      expect(within(details137).queryByText(/CMS137FHIR/)).toBeNull();

      const summaryBar = screen.getByText("Compliance Posture").parentElement!;
      const chip125 = within(summaryBar).getByText(`${LABELS.cms125Short} · Breast Cancer Screening — Overdue`, { exact: true });
      expect(chip125).toHaveAttribute("title", `${LABELS.cms125Title} · Breast Cancer Screening — Overdue`);
      expect(within(summaryBar).getByText(`${LABELS.cms137TranslationShort} · Substance Use Treatment — Overdue`, { exact: true })).toBeInTheDocument();

      const open125 = screen.getByRole("link", { name: `${LABELS.cms125Short} · Breast Cancer Screening` });
      expect(open125).toHaveAttribute("href", "/cases/case-001");
      expect(open125).toHaveAttribute("title", `${LABELS.cms125Title} · Breast Cancer Screening`);
      expect(screen.getByRole("link", { name: `${LABELS.cms137TranslationShort} · Substance Use Treatment` })).toHaveAttribute("href", "/cases/case-137");

      // The authored library version printed beside a CMS-scored row is gone; the label carries the version.
      expect(screen.queryByText(/2\.0\.0/)).toBeNull();
      // A measure with no CMS identity is unchanged, its own version included.
      const osha = document.getElementById("measure-audiogram")!;
      expect(within(osha).getByText("Annual Audiogram Completed", { exact: true })).toBeInTheDocument();
      expect(within(osha).getByText("v1.0", { exact: true })).toBeInTheDocument();
    });

    it("rows that name no logic: the unversioned crosswalk everywhere, though routing names an artifact", async () => {
      // The server's shape for an official row that named no artifact: no logic, and no version.
      withRows(null, undefined, "");
      render(<EmployeeProfilePage />);
      const details125 = await waitFor(() => {
        const row = document.getElementById("measure-cms125");
        expect(row).not.toBeNull();
        return row!;
      });
      expect(await within(details125).findByText(`${LABELS.cms125Plain} · Breast Cancer Screening`, { exact: true })).toBeInTheDocument();
      const summaryBar = screen.getByText("Compliance Posture").parentElement!;
      expect(within(summaryBar).getByText(`${LABELS.cms137Plain} · Substance Use Treatment — Overdue`, { exact: true })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` })).toBeInTheDocument();
      expect(screen.queryByText(/FHIR|2\.0\.0/)).toBeNull();
    });

    it("a CMS measure's row authored CQL scored (no logic) shows the authored version the server read off it", async () => {
      // TWH-shaped: a CMS-identified measure the authored library scored; the server serves its version.
      withRows(null, null, "2.0.0");
      render(<EmployeeProfilePage />);
      const details125 = await waitFor(() => {
        const row = document.getElementById("measure-cms125");
        expect(row).not.toBeNull();
        return row!;
      });
      expect(await within(details125).findByText(`${LABELS.cms125Plain} · Breast Cancer Screening`, { exact: true })).toBeInTheDocument();
      expect(within(details125).getByText("2.0.0", { exact: true })).toBeInTheDocument();
      expect(screen.queryByText(/FHIR/)).toBeNull();
    });

    // The version beside a row with no logic is the row's own fact: it never waits on, or depends on,
    // /api/measures (an authored row once lost its version whenever the identities had not loaded).
    it.each([
      ["still loading", () => new Promise<never>(() => {})],
      ["failed", () => Promise.reject(new Error("measures unavailable"))],
    ])("an authored (TWH) row shows its version while the measure identities are %s", async (_state, measures) => {
      get.mockImplementation((url: string) => {
        if (url === "/api/measures") return measures();
        if (url === "/api/employees/emp-001/profile") {
          return Promise.resolve({
            ...mockProfile,
            measureOutcomes: [{ ...mockProfile.measureOutcomes[1]!, measureVersion: "1.3.0", logic: null }],
            openCases: [],
          });
        }
        return Promise.resolve([]);
      });
      render(<EmployeeProfilePage />);
      const osha = await waitFor(() => {
        const row = document.getElementById("measure-audiogram");
        expect(row).not.toBeNull();
        return row!;
      });
      expect(within(osha).getByText("Annual Audiogram Completed", { exact: true })).toBeInTheDocument();
      expect(within(osha).getByText("1.3.0", { exact: true })).toBeInTheDocument();
    });
  });

  it("hides role and supervisor for patients, while keeping employee profile details byte-identical", async () => {
    setSubject("patient");
    const { unmount } = render(<EmployeeProfilePage />);
    await screen.findByText("Jane Doe", { exact: true });
    expect(screen.queryByText(/Engineer/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Supervisor: Manager Smith/)).not.toBeInTheDocument();
    expect(screen.getByText(/Plant A/)).toBeInTheDocument();

    unmount();
    setSubject("employee");
    render(<EmployeeProfilePage />);
    await screen.findByText("Jane Doe", { exact: true });
    expect(screen.getByText("Engineer · Plant A · Supervisor: Manager Smith")).toBeInTheDocument();
  });

  it("uses result wording for patients and exam wording for employees", async () => {
    setSubject("patient");
    const { unmount } = render(<EmployeeProfilePage />);
    await screen.findByText("Days since result: 100", { exact: true });
    expect(screen.queryByText("Days since exam: 100", { exact: true })).not.toBeInTheDocument();

    unmount();
    setSubject("employee");
    render(<EmployeeProfilePage />);
    expect(await screen.findByText("Days since exam: 100", { exact: true })).toBeInTheDocument();
  });

  it("shows the table's reading, not the stored bucket: out of population is never 'Missing Data' (#671)", async () => {
    const outOfPopulation = {
      ...mockProfile.measureOutcomes[0]!,
      outcomeStatus: "MISSING_DATA",
      displayStatus: "OUT_OF_POPULATION",
      openCaseId: null,
    };
    get.mockImplementation((url: string) => {
      if (url === "/api/employees/emp-001/profile") {
        return Promise.resolve({ ...mockProfile, measureOutcomes: [outOfPopulation], openCases: [] });
      }
      if (url === "/api/measures") {
        return Promise.resolve([
          { id: "cms125", name: "Breast Cancer Screening", status: "Active", identity: { cmsId: "CMS125", mipsQualityId: "112" } },
        ]);
      }
      return Promise.resolve([]);
    });
    render(<EmployeeProfilePage />);
    await waitFor(() => expect(screen.getByText("Compliance Posture")).toBeInTheDocument());

    const summaryBar = screen.getByText("Compliance Posture").parentElement!;
    expect(within(summaryBar).getByText("MIPS 112 · CMS125 · Breast Cancer Screening — Not in population", { exact: true })).toBeInTheDocument();
    const detailRow = document.getElementById("measure-cms125")!;
    expect(within(detailRow).getByText("Not in population", { exact: true })).toBeInTheDocument();
    for (const section of [summaryBar, detailRow]) {
      expect(within(section).queryByText(/missing data/i)).not.toBeInTheDocument();
    }
  });
});
