import React from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get, post: vi.fn(), downloadBlob: vi.fn() };
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
    expect(within(block).getByText(/score 50\.0%/)).toBeInTheDocument();
    expect(within(block).getByText("Cases citing this run: 1")).toBeInTheDocument();
  });
});
