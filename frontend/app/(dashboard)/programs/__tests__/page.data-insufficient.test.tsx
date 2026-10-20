import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

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

import ProgramsPage from "../page";

/**
 * #853 (D12): a measure whose latest run's data was too thin to trust shows NO rate on its card, the
 * headline included. A rate read off uncoded encounters is low because the data is missing.
 */
const card = (over: Record<string, unknown>) => ({
  measureId: "cms122",
  measureName: "Diabetes: Glycemic Status Assessment Greater Than 9%",
  policyRef: "CMS122",
  version: "FHIR v1",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 50,
  denominator: 50,
  compliant: 10,
  dueSoon: 0,
  overdue: 40,
  missingData: 0,
  excluded: 0,
  complianceRate: 20,
  openCaseCount: 0,
  measureRate: null,
  ...over,
});

function serve(program: unknown) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([program]);
    return Promise.resolve([]);
  });
}

beforeEach(() => setSubject("patient"));

describe("ProgramsPage — a thin run shows no rate (#853)", () => {
  it("replaces the rate with the reason when the latest run's data was too thin to trust", async () => {
    serve(card({ dataInsufficient: ["encounterTypeCoded"] }));
    render(<ProgramsPage />);
    expect(await screen.findByTestId("card-thin-cms122")).toHaveTextContent("Data too thin to trust on the latest run");
    // The card's own headline, not the page KPI: the card says no rate.
    expect(screen.getByText("Compliance —")).toBeInTheDocument();
    expect(screen.queryByText("Compliance 20.0%")).not.toBeInTheDocument();
  });

  it("shows the rate as before when the data met its floors", async () => {
    serve(card({ dataInsufficient: null }));
    render(<ProgramsPage />);
    expect(await screen.findByText("Compliance 20.0%")).toBeInTheDocument();
    expect(screen.queryByTestId("card-thin-cms122")).not.toBeInTheDocument();
  });
});
