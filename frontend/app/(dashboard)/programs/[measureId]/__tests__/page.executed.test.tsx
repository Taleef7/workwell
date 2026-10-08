/**
 * The measure page says which logic runs (CMS's FHIR draft, its version, the QDM measure it came from),
 * that the rate is WorkWell's estimate rather than the reported one (patient deployment), and when a
 * year is scored with logic written for another year.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import ProgramDetailPage from "../page";
import { CMS125_ARTIFACT, LABELS } from "@/test/fixtures/scoring-logic";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ measureId: "cms125" }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

const EXECUTED = {
  ecqmId: "CMS125FHIR",
  version: "1.0.000",
  status: "draft",
  statusNote: "posted for public comment Jan–Feb 2026",
  derivedFrom: "CMS125v14",
};

// The run's own evidence: CMS's artifact scored it, named by the server CMS-prefixed (#769).
const program = (over: Record<string, unknown> = {}) => ({
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125v14",
  version: "v1.0",
  latestRunId: "run-1",
  latestRunAt: "2027-01-06T12:00:00Z",
  totalEvaluated: 10,
  denominator: 10,
  compliant: 7,
  dueSoon: 0,
  overdue: 3,
  missingData: 0,
  excluded: 0,
  complianceRate: 70,
  openCaseCount: 3,
  measurementYear: 2027,
  asOf: "2027-01-06",
  logicVintage: null,
  measureRate: {
    official: { ecqmId: "CMS125FHIR", version: "1.0.000" },
    rates: [{ label: null, ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 7, effectiveDenominator: 10, score: 0.7 }],
    unmeasured: 0,
    evaluationErrors: 0,
  },
  scoringLogics: [CMS125_ARTIFACT] as unknown[],
  ...over,
});

const CMS125_TRANSLATION = {
  kind: "workwell-translation",
  label: "WorkWell translation of CMS125v15",
  version: "ww-2027.1",
  url: "urn:workwell:measure:cms125:translation",
  derivedFrom: "CMS125v15",
};

// The official outcome has no forecast (#617): the outlook's note is where the page names the logic again.
let riskOutlook: unknown = null;
const NOT_FORECASTABLE = { forecastable: false, upcomingNonCompliantCount: 0, upcomingExpirations: [], repeatNonCompliers: [], siteComplianceRates: [] };

const TRANSLATION = {
  label: "WorkWell translation of CMS125v15",
  version: "ww-2027.1",
  url: "urn:workwell:measure:cms125:translation",
  derivedFrom: "CMS125v15",
  year: "2027",
};

function mockApi({
  executed = true,
  translation = false,
  cmsIdentity = true,
  summary = program(),
}: { executed?: boolean; translation?: boolean; cmsIdentity?: boolean; summary?: ReturnType<typeof program> } = {}) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") {
      return Promise.resolve([
        {
          id: "cms125",
          name: "Breast Cancer Screening",
          // `cmsIdentity: false`: a measure with no CMS identity at all (authored, occupational).
          identity: cmsIdentity
            ? { cmsId: "CMS125", mipsQualityId: "112", ...(executed ? { executed: EXECUTED } : {}), ...(translation ? { translation: TRANSLATION } : {}) }
            : null,
        },
      ]);
    }
    if (url === "/api/programs") return Promise.resolve([summary]);
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    if (url.includes("/risk-outlook")) return Promise.resolve(riskOutlook);
    return Promise.resolve([]);
  });
}

const ESTIMATE = "WorkWell's estimate from CMS's FHIR logic. WebChart calculates and submits the reported rate.";

describe("ProgramDetailPage executed logic, estimate caveat and vintage", () => {
  beforeEach(() => setSubject("patient"));

  it("names the executed FHIR draft and its version, and the heading names the logic that scored the numbers", async () => {
    mockApi();
    render(<ProgramDetailPage />);
    expect(await screen.findByTestId("executed-logic")).toHaveTextContent(
      "Runs CMS125FHIR v1.0.000, a CMS FHIR draft (posted for public comment Jan–Feb 2026), derived from CMS125v14.",
    );
    const heading = await screen.findByRole("heading", { name: `${LABELS.cms125Full} · Breast Cancer Screening` });
    expect(heading).toHaveAttribute("title", `${LABELS.cms125Title} · Breast Cancer Screening`);
    expect(screen.getByText(/^Version 1\.0\.000/)).toBeInTheDocument();
    expect(screen.queryByText(/^Version v1\.0/)).toBeNull();
    // The eyebrow names the executed artifact, not the QDM measure.
    expect(screen.getByText("CMS125FHIR")).toBeInTheDocument();
    expect(screen.queryByText("CMS125v14")).toBeNull();
  });

  it("labels the numbers with the artifact the run's evidence names, even when today's routing differs", async () => {
    const base = program();
    mockApi({
      summary: program({
        measureRate: { ...base.measureRate, official: { ecqmId: "CMS125FHIR", version: "0.9.000" } },
        scoringLogics: [{ ...CMS125_ARTIFACT, version: "0.9.000", derivedFrom: null, status: "unknown", statusNote: null }],
      }),
    });
    render(<ProgramDetailPage />);
    // The present-tense line describes today's routing; the version beside the numbers is the run's.
    expect(await screen.findByTestId("executed-logic")).toHaveTextContent(/^Runs CMS125FHIR v1\.0\.000/);
    expect(screen.getByRole("heading", { name: "MIPS 112 · CMS125FHIR v0.9.000 · Breast Cancer Screening" })).toBeInTheDocument();
    expect(screen.getByText(/^Version 0\.9\.000/)).toBeInTheDocument();
    expect(screen.queryByText(/^Version 1\.0\.000/)).toBeNull();
    expect(screen.getByText("CMS125FHIR")).toBeInTheDocument();
  });

  it("routing names CMS's artifact but the run's evidence names none: no artifact, no version, unversioned heading", async () => {
    const base = program();
    // Official evidence that recorded no artifact; today's routing must not fill the gap (#769).
    mockApi({ summary: program({ measureRate: { ...base.measureRate, official: null }, scoringLogics: [] }) });
    render(<ProgramDetailPage />);
    await screen.findByTestId("executed-logic"); // the present-tense routing line may stay
    expect(await screen.findByRole("heading", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` })).toBeInTheDocument();
    expect(screen.queryByText("CMS125FHIR")).toBeNull();
    expect(screen.queryByTestId("measure-top-label")).toBeNull();
    expect(screen.queryByText(/^Version /)).toBeNull();
    // Nor the catalog's "v1.0" in the breakdown row.
    expect(screen.queryByRole("cell", { name: "v1.0" })).toBeNull();
    expect(screen.queryByRole("cell", { name: "1.0.000" })).toBeNull();
  });

  it("a run scored by more than one logic or measurement period names none of them as the measure's", async () => {
    // The server's shape for it: no one rate to name (`measureRate` null) — which must not read as an
    // authored run and borrow the catalog's "v1.0".
    mockApi({ summary: program({ measureRate: null, scoringLogics: [CMS125_ARTIFACT, CMS125_TRANSLATION] }) });
    render(<ProgramDetailPage />);
    expect(await screen.findByRole("heading", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` })).toBeInTheDocument();
    expect(screen.getByTestId("mixed-logics").textContent).toBe(
      "Scored by more than one logic or measurement period: CMS125FHIR v1.0.000 (from CMS125v14); WorkWell translation of CMS125v15 (ww-2027.1).",
    );
    expect(screen.queryByTestId("measure-top-label")).toBeNull();
    // Neither the catalog's "v1.0" nor either logic's version stands for the run.
    expect(screen.queryByText(/^Version /)).toBeNull();
    expect(screen.queryByRole("cell", { name: "v1.0" })).toBeNull();
  });

  it("a run with no official evidence is not labelled with today's FHIR artifact", async () => {
    // Routed now (executed present), but the winning run was scored by authored CQL (no measureRate).
    mockApi({ summary: program({ measureRate: null, scoringLogics: [] }) });
    render(<ProgramDetailPage />);
    await screen.findByTestId("executed-logic"); // the present-tense routing line may stay
    expect(screen.getByRole("heading", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` })).toBeInTheDocument();
    // No version line: the catalog's "v1.0" is not what scored a CMS measure's numbers, and the run named
    // nothing else.
    expect(screen.queryByText(/^Version /)).toBeNull();
    expect(screen.queryByText(/Version v1\.0/)).toBeNull();
    expect(screen.queryByText("CMS125FHIR")).toBeNull();
    // Nor with the QDM measure version the catalog cites: authored CQL is not CMS125v14 either.
    expect(screen.queryByTestId("measure-top-label")).toBeNull();
    // The outcome-by-version row says it does not know, as the header does.
    const breakdown = screen.getByRole("region", { name: "Outcome breakdown by version table" });
    expect(within(breakdown).queryByRole("cell", { name: "v1.0" })).toBeNull();
    expect(within(breakdown).getByRole("cell", { name: "—" })).toBeInTheDocument();
    // Still an estimate, but no claim that CMS's FHIR logic produced it.
    expect(screen.getByText("WorkWell's estimate. WebChart calculates and submits the reported rate.")).toBeInTheDocument();
    expect(screen.queryByText(ESTIMATE)).toBeNull();
  });

  it("counts that fold in the authored scale tenant's are not labelled with the live run's artifact", async () => {
    // The live run's rows name CMS's artifact (scoringLogics), but the totals also hold the scale tenant's.
    mockApi({ summary: program({ includesAuthoredScaleCounts: true }) });
    render(<ProgramDetailPage />);
    await screen.findByTestId("executed-logic");
    // No version at all: not the artifact's, and not the catalog's "v1.0" over a CMS measure's numbers.
    expect(screen.queryByText(/^Version /)).toBeNull();
    expect(screen.queryByText(/Version v1\.0/)).toBeNull();
    const breakdown = screen.getByRole("region", { name: "Outcome breakdown by version table" });
    expect(within(breakdown).queryByRole("cell", { name: "v1.0" })).toBeNull();
    expect(within(breakdown).getByRole("cell", { name: "—" })).toBeInTheDocument();
    expect(screen.queryByText("CMS125FHIR")).toBeNull();
    expect(screen.getByRole("heading", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` })).toBeInTheDocument();
    // Mixed totals carry no single measure identity: not the artifact, and not the QDM version either.
    expect(screen.queryByTestId("measure-top-label")).toBeNull();
  });

  it("the label above the name is the executed artifact on an official run", async () => {
    mockApi();
    render(<ProgramDetailPage />);
    expect(await screen.findByTestId("measure-top-label")).toHaveTextContent("CMS125FHIR");
  });

  it("a measure whose policy reference is not a CMS measure version keeps it as the label", async () => {
    mockApi({ executed: false, summary: program({ measureRate: null, scoringLogics: [], policyRef: "OSHA 29 CFR 1910.95" }) });
    render(<ProgramDetailPage />);
    expect(await screen.findByTestId("measure-top-label")).toHaveTextContent("OSHA 29 CFR 1910.95");
  });

  it("an authored measure (no CMS identity) keeps its catalog version and shows no executed-logic line", async () => {
    mockApi({ cmsIdentity: false, summary: program({ measureRate: null, scoringLogics: [], policyRef: "OSHA 29 CFR 1910.95" }) });
    render(<ProgramDetailPage />);
    expect(await screen.findByText(/^Version v1\.0/)).toBeInTheDocument();
    const breakdown = screen.getByRole("region", { name: "Outcome breakdown by version table" });
    expect(within(breakdown).getByRole("cell", { name: "v1.0" })).toBeInTheDocument();
    expect(screen.queryByTestId("executed-logic")).toBeNull();
  });

  it("a run the server marks mixed names no logic as the measure's, though it lists one", async () => {
    // Authored rows beside CMS's artifact: only the artifact names itself, so one logic is served.
    mockApi({ summary: program({ scoringConflict: true, scoringLogics: [CMS125_ARTIFACT] }) });
    render(<ProgramDetailPage />);
    const heading = await screen.findByRole("heading", { name: `${LABELS.cms125Plain} · Breast Cancer Screening` });
    expect(heading).toHaveAttribute("title", `${LABELS.cms125Plain} · Breast Cancer Screening`);
    expect(screen.getByTestId("mixed-logics").textContent).toBe(
      "Scored by more than one logic or measurement period: CMS125FHIR v1.0.000 (from CMS125v14).",
    );
    expect(screen.queryByTestId("measure-top-label")).toBeNull();
    expect(screen.queryByText(/^Version /)).toBeNull();
    const breakdown = screen.getByRole("region", { name: "Outcome breakdown by version table" });
    expect(within(breakdown).queryByRole("cell", { name: "1.0.000" })).toBeNull();
    expect(within(breakdown).getByRole("cell", { name: "—" })).toBeInTheDocument();
  });

  it("says beside the rates that they are WorkWell's estimate, on the patient deployment", async () => {
    mockApi();
    render(<ProgramDetailPage />);
    await screen.findByTestId("executed-logic");
    const notes = screen.getAllByText(ESTIMATE);
    expect(notes).toHaveLength(2); // the headline rate and the CMS measure rate panel
    expect(screen.getByText("Compliance 70.0%")).toHaveAttribute("aria-describedby", expect.stringContaining("rate-estimate-note"));
  });

  it("shows no estimate caveat on the occupational deployment, where the measures are WorkWell's own", async () => {
    setSubject("employee");
    mockApi();
    render(<ProgramDetailPage />);
    await screen.findByTestId("executed-logic");
    expect(screen.queryByText(ESTIMATE)).toBeNull();
  });

  it("says when the year was scored with the previous year's logic", async () => {
    mockApi({
      summary: program({
        logicVintage: { artifactYears: "2026", measurementYear: 2027, note: "Scored with the 2026 FHIR logic; 2027 logic not yet available" },
      }),
    });
    render(<ProgramDetailPage />);
    expect(await screen.findByTestId("logic-vintage")).toHaveTextContent("Scored with the 2026 FHIR logic; 2027 logic not yet available.");
  });

  it("says nothing about vintage when the run's year is covered", async () => {
    mockApi();
    render(<ProgramDetailPage />);
    await screen.findByTestId("executed-logic");
    expect(screen.queryByTestId("logic-vintage")).toBeNull();
  });

  it("a run a WorkWell translation scored is labelled with the translation, never with today's CMS artifact", async () => {
    riskOutlook = NOT_FORECASTABLE;
    const base = program();
    mockApi({
      translation: true,
      summary: program({
        measureRate: {
          ...base.measureRate,
          source: "translation-evidence",
          official: { ecqmId: null, version: "ww-2027.1", kind: "derived", label: "WorkWell translation of CMS125v15", derivedFrom: "CMS125v15" },
        },
        // Routing (identity.executed) says CMS125FHIR; the run's rows say the translation.
        scoringLogics: [CMS125_TRANSLATION],
      }),
    });
    render(<ProgramDetailPage />);
    expect(await screen.findByTestId("measure-top-label")).toHaveTextContent("WorkWell translation of CMS125v15");
    const heading = await screen.findByRole("heading", { name: "MIPS 112 · WorkWell translation of CMS125v15 (ww-2027.1) · Breast Cancer Screening" });
    expect(heading).toHaveAttribute("title", "MIPS 112 · WorkWell translation of CMS125v15 (ww-2027.1), not a CMS measure · Breast Cancer Screening");
    expect(screen.getByText(/^Version ww-2027\.1/)).toBeInTheDocument();
    // The run's evidence carries no eCQM id; today's CMS artifact must not fill the gap.
    expect(screen.queryByText("CMS125FHIR")).toBeNull();
    // Both logics, each with what it scores.
    expect(screen.getByTestId("executed-logic")).toHaveTextContent(/^Runs CMS125FHIR v1\.0\.000/);
    expect(screen.getByTestId("translation-logic")).toHaveTextContent("For 2027: WorkWell translation of CMS125v15 (ww-2027.1), not a CMS measure.");
    // The rate panel and the estimate notes credit the translation, not CMS.
    expect(screen.getByText("Measure rate · WorkWell translation")).toBeInTheDocument();
    expect(screen.queryByText("CMS measure rate")).toBeNull();
    expect(screen.getByText(/^Scored as a quality measure is reported:/)).toBeInTheDocument();
    expect(screen.queryByText(/Scored the way CMS reports it/)).toBeNull();
    expect(screen.getAllByText("WorkWell's estimate from its own translation of CMS's logic. WebChart calculates and submits the reported rate.")).toHaveLength(2);
    expect(screen.queryByText(ESTIMATE)).toBeNull();
    // Nothing else on the page credits CMS's logic with these numbers.
    expect(screen.queryByText(/CMS measure logic|CMS's FHIR logic/)).toBeNull();
    expect(await screen.findByTestId("outlook-not-forecastable")).toHaveTextContent("The measure logic (WorkWell's translation) scores the measurement year");
    riskOutlook = null;
  });

  it("a translation routed for next year changes nothing on a run CMS's draft scored, but the translation line", async () => {
    const base = program();
    mockApi({ translation: true, summary: program({ measureRate: { ...base.measureRate, official: { ecqmId: "CMS125FHIR", version: "1.0.000" } } }) });
    render(<ProgramDetailPage />);
    expect(await screen.findByTestId("measure-top-label")).toHaveTextContent("CMS125FHIR");
    expect(await screen.findByRole("heading", { name: `${LABELS.cms125Full} · Breast Cancer Screening` })).toBeInTheDocument();
    expect(screen.getByTestId("translation-logic")).toHaveTextContent(/^For 2027: WorkWell translation of CMS125v15/);
    expect(screen.getByText("CMS measure rate")).toBeInTheDocument();
    expect(screen.getByText(/^Scored the way CMS reports it:/)).toBeInTheDocument();
    expect(screen.getAllByText(ESTIMATE)).toHaveLength(2);
  });
});
