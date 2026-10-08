import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CMS125_ARTIFACT, CMS137_TRANSLATION, LABELS, ROUTED_IDENTITIES } from "@/test/fixtures/scoring-logic";

const get = vi.fn();
const apiMock = { get, getWithHeaders: vi.fn(async (url: string) => ({ data: await get(url), headers: new Headers() })), post: vi.fn(), downloadBlob: vi.fn() };
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => new URLSearchParams());
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock, useSearchParams: () => searchParamsMock }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));
vi.mock("@/features/datavis/NitroGridClient", () => ({ default: () => <div data-testid="outcomes-grid" /> }));

import RunsPage from "../page";

/** A terminal run explains its own numbers in one stated unit (ADR-077 d7): what it set out to
 *  evaluate, what it persisted, what errored, who was outside the population, and what the rate counts. */
const run = {
  runId: "run-1", measureName: "Diabetes: Glycemic Status Assessment", status: "COMPLETED", scopeType: "MEASURE", triggerType: "MANUAL",
  startedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:01:00Z", durationMs: 60_000,
  totalEvaluated: 4, compliantCount: 1, nonCompliantCount: 3,
};
const summary = {
  ...run, measureVersion: "1.0", totalCases: 1, passRate: 25, outcomeCounts: [{ status: "OVERDUE", count: 1 }],
  dataFreshAsOf: "2026-08-30T00:01:00Z", dataFreshnessMinutes: 1, retentionNotice: null,
};
const reconciliation = {
  runId: "run-1", status: "COMPLETED", unit: "subject-measure pairs", workItems: 4, rowsPersisted: 4,
  byStatus: [{ status: "OVERDUE", count: 1 }], evaluationErrors: 1,
  official: {
    measureId: "cms122",
    rates: [{ label: null, ipp: 2, denom: 2, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 2, score: 0.5 }],
    outOfPopulation: 1, unmeasured: 1, evaluationErrors: 1,
  },
  casesCiting: 1, compaction: { exposed: false, cutoff: null }, notes: [],
};

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/runs?limit=20") return Promise.resolve([run]);
    if (url === "/api/runs/run-1") return Promise.resolve(summary);
    if (url === "/api/runs/run-1/reconciliation") return Promise.resolve(reconciliation);
    return Promise.resolve([]);
  });
});

describe("RunsPage reconciliation", () => {
  it("renders the ladder in its stated unit", async () => {
    render(<RunsPage />);
    const block = await screen.findByTestId("run-reconciliation");
    expect(within(block).getByText("Reconciliation (subject-measure pairs)")).toBeInTheDocument();
    expect(within(block).getByText("Set out to evaluate: 4")).toBeInTheDocument();
    expect(within(block).getByText("Rows persisted: 4")).toBeInTheDocument();
    expect(within(block).getByText("Evaluation errors (in no population): 1")).toBeInTheDocument();
    expect(within(block).getByText("Evaluated, not in population: 1")).toBeInTheDocument();
    expect(within(block).getByText(/CMS measure rate 50\.0% of the measure's population/)).toBeInTheDocument();
    expect(within(block).getByText("Cases citing this run: 1")).toBeInTheDocument();
    expect(within(block).queryByTestId("run-translation-logic")).toBeNull();
    expect(screen.getByRole("button", { name: "QRDA III (XML)" })).toBeInTheDocument();
  });

  it("a run a WorkWell translation scored names it, credits no CMS rate, and offers no QRDA III", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/runs?limit=20") return Promise.resolve([run]);
      if (url === "/api/runs/run-1") return Promise.resolve(summary);
      if (url === "/api/runs/run-1/reconciliation") {
        return Promise.resolve({ ...reconciliation, official: { ...reconciliation.official, logic: { kind: "workwell-translation", label: "WorkWell translation of CMS122v15" } } });
      }
      return Promise.resolve([]);
    });
    render(<RunsPage />);
    const block = await screen.findByTestId("run-reconciliation");
    expect(within(block).getByTestId("run-translation-logic")).toHaveTextContent("Scored by: WorkWell translation of CMS122v15, not a CMS measure");
    expect(within(block).getByText(/, measure rate 50\.0% of the measure's population/)).toBeInTheDocument();
    expect(within(block).queryByText(/CMS measure rate/)).toBeNull();
    expect(screen.getByTestId("qrda-not-offered")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QRDA III (XML)" })).toBeNull();
    expect(screen.getByRole("button", { name: "MeasureReport (FHIR)" })).toBeInTheDocument();
  });
});

describe("RunsPage names the logic that scored each measure's rows (#769)", () => {
  // Routing (identity.executed) names CMS's artifact for every CMS measure; the run's rows say otherwise.
  const MEASURES = [
    { id: "cms125", name: "Breast Cancer Screening", version: "v1.0", status: "Active", identity: ROUTED_IDENTITIES.cms125 },
    { id: "cms137", name: "Substance Use Treatment", version: "v1.0", status: "Active", identity: ROUTED_IDENTITIES.cms137 },
    { id: "cms122", name: "Diabetes HbA1c", version: "v1.0", status: "Active", identity: { cmsId: "CMS122", mipsQualityId: "001", executed: ROUTED_IDENTITIES.cms125.executed } },
    { id: "cms130", name: "Colorectal Cancer Screening", version: "v1.0", status: "Active", identity: { cmsId: "CMS130", mipsQualityId: "113", executed: ROUTED_IDENTITIES.cms125.executed } },
    { id: "audiogram", name: "Annual Audiogram Completed", version: "v1.0", status: "Active", identity: null },
  ];
  const CMS130_ARTIFACT = { ...CMS125_ARTIFACT, ecqmId: "CMS130FHIR", derivedFrom: "CMS130v14" };
  const CMS130_TRANSLATION = { ...CMS137_TRANSLATION, label: "WorkWell translation of CMS130v15", derivedFrom: "CMS130v15" };

  function withScoringLogic(scoringLogic: unknown) {
    get.mockReset().mockImplementation((url: string) => {
      if (url === "/api/runs?limit=20") return Promise.resolve([{ ...run, scopeType: "ALL_PROGRAMS", measureName: "All Programs" }]);
      if (url === "/api/measures") return Promise.resolve(MEASURES);
      if (url === "/api/runs/run-1") return Promise.resolve({ ...summary, scopeType: "ALL_PROGRAMS", measureName: "All Programs" });
      if (url === "/api/runs/run-1/reconciliation") return Promise.resolve({ ...reconciliation, official: null, scoringLogic });
      return Promise.resolve([]);
    });
  }

  it("one line per measure: the full form; more than one logic is named as such; authored is the name", async () => {
    withScoringLogic([
      { measureId: "audiogram", logics: [] },
      { measureId: "cms122", logics: [] },
      { measureId: "cms125", logics: [CMS125_ARTIFACT] },
      { measureId: "cms130", logics: [CMS130_ARTIFACT, CMS130_TRANSLATION] },
      { measureId: "cms137", logics: [CMS137_TRANSLATION] },
    ]);
    render(<RunsPage />);
    const block = await screen.findByTestId("run-scoring-logic");
    await waitFor(() => expect(within(block).getAllByRole("listitem")[2].textContent).toBe(`${LABELS.cms125Full} · Breast Cancer Screening`));
    const lines = within(block).getAllByRole("listitem");
    expect(lines.map((li) => li.textContent)).toEqual([
      "Annual Audiogram Completed",
      // Routing names an artifact, the rows name none: the unversioned crosswalk.
      "MIPS 001 · CMS122 · Diabetes HbA1c",
      `${LABELS.cms125Full} · Breast Cancer Screening`,
      "MIPS 113 · CMS130 · Colorectal Cancer Screening: Scored by more than one logic or measurement period: CMS130FHIR v1.0.000 (from CMS130v14); WorkWell translation of CMS130v15 (ww-2027.1)",
      // Routing names CMS137FHIR, the rows name the translation.
      `${LABELS.cms137TranslationFull} · Substance Use Treatment`,
    ]);
    expect(lines[2]).toHaveAttribute("title", `${LABELS.cms125Title} · Breast Cancer Screening`);
    expect(lines[4]).toHaveAttribute("title", `${LABELS.cms137TranslationTitle} · Substance Use Treatment`);
  });

  it("an older server that sends no scoringLogic shows no Scored-by list", async () => {
    withScoringLogic(undefined);
    render(<RunsPage />);
    await screen.findByTestId("run-reconciliation");
    expect(screen.queryByTestId("run-scoring-logic")).toBeNull();
  });

  it("Run This Measure offers each measure by its unversioned crosswalk, never the catalog's v1.0", async () => {
    withScoringLogic([]);
    render(<RunsPage />);
    await userEvent.click(await screen.findByRole("combobox", { name: "Scope" }));
    await userEvent.click(screen.getByRole("option", { name: "Measure" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Measure" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual([
      "Select a measure",
      "MIPS 112 · CMS125 · Breast Cancer Screening (Active)",
      "MIPS 305 · CMS137 · Substance Use Treatment (Active)",
      "MIPS 001 · CMS122 · Diabetes HbA1c (Active)",
      "MIPS 113 · CMS130 · Colorectal Cancer Screening (Active)",
      "Annual Audiogram Completed (Active)",
    ]);
  });
});
