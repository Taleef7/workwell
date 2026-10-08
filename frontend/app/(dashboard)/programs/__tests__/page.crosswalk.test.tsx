import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProgramsPage from "../page";
import { CMS125_ARTIFACT, CMS137_ARTIFACT, CMS137_TRANSLATION, LABELS, ROUTED_IDENTITIES } from "@/test/fixtures/scoring-logic";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

const cmsProgram = {
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125",
  version: "v1.0",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 10,
  compliant: 5,
  dueSoon: 2,
  overdue: 2,
  missingData: 1,
  excluded: 0,
  complianceRate: 50,
  openCaseCount: 4,
};

const oshaProgram = {
  measureId: "audiogram",
  measureName: "Annual Audiogram Completed",
  policyRef: "OSHA 1910.95",
  version: "v1.0",
  latestRunId: "run-2",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 20,
  compliant: 18,
  dueSoon: 1,
  overdue: 1,
  missingData: 0,
  excluded: 0,
  complianceRate: 90,
  openCaseCount: 2,
};

describe("ProgramsPage crosswalk heading rendering", () => {
  beforeEach(() => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          {
            id: "cms125",
            name: "Breast Cancer Screening",
            identity: { cmsId: "CMS125", mipsQualityId: "112" },
          },
          {
            id: "audiogram",
            name: "Annual Audiogram Completed",
            identity: null,
          },
        ]);
      }
      if (url.startsWith("/api/programs/overview")) {
        return Promise.resolve([cmsProgram, oshaProgram]);
      }
      if (url.includes("/top-drivers")) {
        return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      }
      return Promise.resolve([]);
    });
  });

  it("renders MIPS 112 · CMS125 · Breast Cancer Screening for cms125 and plain name for audiogram", async () => {
    render(<ProgramsPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "MIPS 112 · CMS125 · Breast Cancer Screening" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Annual Audiogram Completed" })).toBeInTheDocument();
    });

    // Verify status chip ariaLabel uses the crosswalk label
    expect(screen.getByRole("link", { name: "MIPS 112 · CMS125 · Breast Cancer Screening: Overdue 2" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Annual Audiogram Completed: Overdue 1" })).toBeInTheDocument();
  });

  describe("names the logic that scored the card's numbers, never today's routing (#769)", () => {
    function withPrograms(programs: unknown[]) {
      get.mockImplementation((url: string) => {
        if (url === "/api/measures") {
          return Promise.resolve([
            { id: "cms125", name: "Breast Cancer Screening", identity: ROUTED_IDENTITIES.cms125 },
            { id: "cms137", name: "Substance Use Treatment", identity: ROUTED_IDENTITIES.cms137 },
            { id: "audiogram", name: "Annual Audiogram Completed", identity: null },
          ]);
        }
        if (url.startsWith("/api/programs/overview")) return Promise.resolve(programs);
        if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
        return Promise.resolve([]);
      });
    }
    const cms137Program = { ...cmsProgram, measureId: "cms137", measureName: "Substance Use Treatment" };

    it("one logic: the chip form on the card, the full form in its title and link", async () => {
      withPrograms([
        { ...cmsProgram, scoringLogics: [CMS125_ARTIFACT] },
        // Routing says CMS's artifact; the run's rows say the translation.
        { ...cms137Program, scoringLogics: [CMS137_TRANSLATION] },
        { ...oshaProgram, scoringLogics: [] },
      ]);
      render(<ProgramsPage />);
      const cms125 = await screen.findByRole("heading", { name: `${LABELS.cms125Short} · Breast Cancer Screening` });
      expect(cms125).toHaveAttribute("title", `${LABELS.cms125Title} · Breast Cancer Screening`);
      expect(screen.getByRole("link", { name: `View ${LABELS.cms125Title} · Breast Cancer Screening detail` })).toBeInTheDocument();
      // The status chips' accessible names carry the full wording, as the title does (never the chip form).
      expect(screen.getByRole("link", { name: `${LABELS.cms125Title} · Breast Cancer Screening: Overdue 2` })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: `${LABELS.cms125Short} · Breast Cancer Screening: Overdue 2` })).toBeNull();

      const cms137 = screen.getByRole("heading", { name: `${LABELS.cms137TranslationShort} · Substance Use Treatment` });
      expect(cms137).toHaveAttribute("title", `${LABELS.cms137TranslationTitle} · Substance Use Treatment`);
      expect(screen.getByRole("link", { name: `${LABELS.cms137TranslationTitle} · Substance Use Treatment: Overdue 2` })).toBeInTheDocument();
      expect(screen.queryByText(/CMS137FHIR/)).toBeNull();
      // A measure with no CMS identity is unchanged.
      expect(screen.getByRole("heading", { name: "Annual Audiogram Completed" })).toBeInTheDocument();
    });

    it("no logic on the summary: the unversioned crosswalk, though routing names an executed artifact", async () => {
      withPrograms([{ ...cmsProgram }]);
      render(<ProgramsPage />);
      const heading = await screen.findByRole("heading", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` });
      expect(heading).toHaveAttribute("title", `${LABELS.cms125Plain} · Breast Cancer Screening`);
      expect(screen.queryByText(/CMS125FHIR/)).toBeNull();
    });

    it("more than one logic: the unversioned crosswalk and a line naming each", async () => {
      withPrograms([{ ...cms137Program, scoringLogics: [CMS137_ARTIFACT, CMS137_TRANSLATION] }]);
      render(<ProgramsPage />);
      expect(await screen.findByRole("heading", { name: `${LABELS.cms137Plain} · Substance Use Treatment` })).toBeInTheDocument();
      expect(screen.getByTestId("card-logics-cms137").textContent).toBe(
        "Scored by more than one logic or measurement period: CMS137FHIR v1.0.000 (from CMS137v14); WorkWell translation of CMS137v15 (ww-2027.1)",
      );
    });

    it("a run the server marks mixed is mixed though it lists one logic: no versioned label, and the line says so", async () => {
      // Authored rows beside CMS's artifact: the authored rows name no logic, so only one is served.
      withPrograms([{ ...cms137Program, scoringLogics: [CMS137_ARTIFACT], scoringConflict: true }]);
      render(<ProgramsPage />);
      const heading = await screen.findByRole("heading", { name: `${LABELS.cms137Plain} · Substance Use Treatment` });
      expect(heading).toHaveAttribute("title", `${LABELS.cms137Plain} · Substance Use Treatment`);
      expect(screen.getByTestId("card-logics-cms137").textContent).toBe(
        "Scored by more than one logic or measurement period: CMS137FHIR v1.0.000 (from CMS137v14)",
      );
      expect(screen.queryByText(LABELS.cms137ArtifactShort, { exact: false })).toBeNull();
      expect(screen.getByRole("link", { name: `${LABELS.cms137Plain} · Substance Use Treatment: Overdue 2` })).toBeInTheDocument();
    });

    it("a run the server marks mixed with no logic served says it was mixed, naming none", async () => {
      withPrograms([{ ...cms137Program, scoringLogics: [], scoringConflict: true }]);
      render(<ProgramsPage />);
      expect(await screen.findByRole("heading", { name: `${LABELS.cms137Plain} · Substance Use Treatment` })).toBeInTheDocument();
      expect(screen.getByTestId("card-logics-cms137").textContent).toBe("Scored by more than one logic or measurement period");
    });

    it("totals that fold in the authored scale tenant's name no logic, whatever scoringLogics says", async () => {
      withPrograms([{ ...cmsProgram, scoringLogics: [CMS125_ARTIFACT], includesAuthoredScaleCounts: true }]);
      render(<ProgramsPage />);
      const heading = await screen.findByRole("heading", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` });
      expect(heading).toHaveAttribute("title", `${LABELS.cms125Plain} · Breast Cancer Screening`);
      expect(screen.queryByText(/CMS125FHIR/)).toBeNull();
      expect(screen.queryByRole("link", { name: /CMS125FHIR/ })).toBeNull();
    });
  });
});
