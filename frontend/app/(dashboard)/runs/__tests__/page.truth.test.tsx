import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #668: Run History says what a run is and what its numbers mean. Each test pins one thing the live
 * sandbox showed wrong on 2026-09-23.
 */
const get = vi.fn();
const getWithHeaders = vi.fn();
const apiMock = { get, getWithHeaders, post: vi.fn(), downloadBlob: vi.fn() };
const globals = vi.hoisted(() => ({ current: { siteId: "", from: "", to: "" } }));
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
// Stable across renders, as the real hooks are: a fresh object per render re-fires every effect that
// depends on it, which is a loop the real page never sees.
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => new URLSearchParams());
vi.mock("next/navigation", () => ({ useRouter: () => routerMock, useSearchParams: () => searchParamsMock }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => globals.current }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));
vi.mock("@/features/datavis/NitroGridClient", () => ({
  default: ({ rows }: { rows: Array<Record<string, unknown>> }) => (
    <div data-testid="outcomes-grid">
      {rows.map((r, i) => (
        <span key={i} data-testid="outcome-cell">{String(r.outcome)}</span>
      ))}
    </div>
  ),
}));

import RunsPage from "../page";

// Run 2abc5b0d's own numbers: a colorectal-screening run over the 20,000-patient sandbox.
const run = {
  runId: "run-1", measureName: "Colorectal Cancer Screening", measureId: "cms130", status: "COMPLETED", scopeType: "MEASURE",
  triggerType: "MANUAL", startedAt: "2026-09-22T15:30:53Z", completedAt: "2026-09-22T15:45:21Z", durationMs: 867_000,
  totalEvaluated: 20_000, compliantCount: 3_388, nonCompliantCount: 16_248,
};
const nightly = { ...run, runId: "run-2", measureName: "All Programs", measureId: null, scopeType: "ALL_PROGRAMS", triggerType: "SCHEDULED", durationMs: 4_320_000 };
const summary = {
  ...run, measureVersion: "v1.0", totalCases: 0, passRate: 16.94, notInPopulation: 11_543,
  outcomeCounts: [
    { status: "OVERDUE", count: 4_705 },
    { status: "MISSING_DATA", count: 11_543 },
    { status: "COMPLIANT", count: 3_388 },
    { status: "EXCLUDED", count: 364 },
  ],
  dataFreshAsOf: "2026-09-22T15:45:19Z", dataFreshnessMinutes: 60, retentionNotice: null,
};
const reconciliation = {
  runId: "run-1", status: "COMPLETED", unit: "subject-measure pairs", workItems: 20_000, rowsPersisted: 20_000,
  byStatus: [], evaluationErrors: 0,
  official: {
    measureId: "cms130",
    rates: [{ label: null, ipp: 8_457, denom: 8_457, denex: 364, denexcep: 0, numer: 3_388, effectiveDenominator: 8_093, score: 0.4186 }],
    outOfPopulation: 11_543, unmeasured: 0, evaluationErrors: 0,
  },
  casesCiting: 0, compaction: { exposed: false, cutoff: null }, notes: [],
};
const outcomeRows = [
  { employeeName: "Adriana Agustin", employeeExternalId: "pat-01565", role: "Patient", site: "Kihei Clinic", outcomeStatus: "MISSING_DATA", displayStatus: "OUT_OF_POPULATION", daysSinceExam: null, waiverStatus: null, caseId: null },
  { employeeName: "Ben Aoki", employeeExternalId: "pat-00002", role: "Patient", site: "Kihei Clinic", outcomeStatus: "MISSING_DATA", displayStatus: "MISSING_DATA", daysSinceExam: null, waiverStatus: null, caseId: null },
];

const listCalls = () => get.mock.calls.map(([url]) => String(url)).filter((u) => u.startsWith("/api/runs?"));

function answer(list: unknown[] | Error) {
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/runs?")) return list instanceof Error ? Promise.reject(list) : Promise.resolve(list);
    if (url === "/api/runs/run-1") return Promise.resolve(summary);
    if (url === "/api/runs/run-2") return Promise.resolve({ ...summary, ...nightly });
    if (url.endsWith("/reconciliation")) return Promise.resolve(reconciliation);
    return Promise.resolve([]);
  });
  getWithHeaders.mockReset().mockImplementation(async (url: string) =>
    url.endsWith("/outcomes")
      ? { data: outcomeRows, headers: new Headers({ "X-Total-Count": "20000" }) }
      : { data: await get(url), headers: new Headers() },
  );
}

beforeEach(() => {
  globals.current = { siteId: "", from: "", to: "" };
  answer([run, nightly]);
});

describe("RunsPage says what a run is and what its numbers mean (#668)", () => {
  it("labels the two rates, and counts patients outside the population on their own line", async () => {
    render(<RunsPage />);
    expect(await screen.findByText("Compliant: 16.9% of everyone evaluated (3,388 of 20,000)")).toBeInTheDocument();
    expect(within(await screen.findByTestId("run-reconciliation")).getByText(/CMS measure rate 41\.9% of the measure's population/)).toBeInTheDocument();
    expect(screen.getByText("Missing Data: 0")).toBeInTheDocument();
    expect(screen.getByText("Not in population: 11543")).toBeInTheDocument();
    expect(screen.queryByText(/^Missing Data: 11543$/)).not.toBeInTheDocument();
    expect(screen.getByText("Cases last updated by this run: 0")).toBeInTheDocument();
  });

  it("says how many outcomes it shows of how many, and shows each row's displayed status", async () => {
    render(<RunsPage />);
    expect(await screen.findByTestId("outcomes-capped")).toHaveTextContent("Showing 2 of 20,000. The outcomes CSV has every row.");
    const cells = (await screen.findAllByTestId("outcome-cell")).map((c) => c.textContent);
    expect(cells).toEqual(["Not in population", "Missing Data"]);
  });

  it("shows a running run's elapsed time, not '0s', when this page did not start it (#644)", async () => {
    const started = new Date(Date.now() - 15 * 60_000 - 5_000).toISOString();
    answer([{ ...nightly, runId: "run-3", status: "RUNNING", completedAt: null, durationMs: 0, startedAt: started }, run]);
    render(<RunsPage />);
    const row = (await screen.findAllByText(/^15m \d+s$/))[0];
    expect(row).toBeInTheDocument();
    expect(screen.queryByText("0s")).not.toBeInTheDocument();
  });

  it("shows a finished run's duration past an hour, not '-'", async () => {
    render(<RunsPage />);
    expect(await screen.findByText("1h 12m")).toBeInTheDocument();
    expect(screen.getAllByText("14m 27s").length).toBeGreaterThan(0);
  });

  it("a failed list load says so, with a retry, and never 'No runs yet'", async () => {
    answer(new Error("No database connection was available in time. Try again shortly."));
    render(<RunsPage />);
    const alert = await screen.findByText(/Couldn't load runs: No database connection/);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument();
  });

  it("filters that exclude every run say so; an empty history says 'No runs yet'", async () => {
    globals.current = { siteId: "", from: "2030-01-01", to: "" };
    answer([]);
    const { unmount } = render(<RunsPage />);
    expect(await screen.findByText("No runs match these filters.")).toBeInTheDocument();
    unmount();

    globals.current = { siteId: "", from: "", to: "" };
    render(<RunsPage />);
    expect(await screen.findByText("No runs yet. Use the run controls above to start one.")).toBeInTheDocument();
  });

  it("does not send the global site filter, and says why", async () => {
    globals.current = { siteId: "Kihei Clinic", from: "", to: "" };
    render(<RunsPage />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls().every((u) => !new URLSearchParams(u.split("?")[1]).has("site"))).toBe(true);
    expect(screen.getByText("Run history isn't filtered by site: most runs cover every site.")).toBeInTheDocument();
    // The grid is every site's rows; the outcomes CSV keeps the site, and the note says so.
    expect(await screen.findByTestId("outcomes-capped")).toHaveTextContent("Showing 2 of 20,000. The outcomes CSV has every Kihei Clinic row.");
  });

  it("Refresh clears an error left by a failed detail load", async () => {
    let failDetail = true;
    const base = get.getMockImplementation()!;
    get.mockImplementation((url: string) =>
      url === "/api/runs/run-1" && failDetail ? Promise.reject(new Error("Detail load failed")) : base(url),
    );
    render(<RunsPage />);
    expect(await screen.findByText("Detail load failed")).toBeInTheDocument();
    failDetail = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Detail load failed")).not.toBeInTheDocument());
  });

  it("clears the detail when filters remove the selected run, with no live '0s ●'", async () => {
    const { rerender } = render(<RunsPage />);
    expect(await screen.findByText("Compliant: 16.9% of everyone evaluated (3,388 of 20,000)")).toBeInTheDocument();

    answer([]);
    globals.current = { siteId: "", from: "2030-01-01", to: "" };
    rerender(<RunsPage />);
    expect(await screen.findByText("No runs match these filters.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Compliant: 16\.9%/)).not.toBeInTheDocument());
    expect(screen.queryByText(/●/)).not.toBeInTheDocument();
    expect(screen.getByText("Select a run to view details.")).toBeInTheDocument();
  });
});
