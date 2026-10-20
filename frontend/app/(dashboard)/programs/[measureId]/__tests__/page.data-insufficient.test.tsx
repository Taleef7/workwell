import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProgramDetailPage from "../page";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({ useParams: () => ({ measureId: "cms122" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));

/**
 * #853: one click from a programs card that says "Data too thin to trust", the measure page must not
 * state the rate or a change "from previous" either.
 */
const program = {
  measureId: "cms122",
  measureName: "Diabetes: Glycemic Status Assessment",
  policyRef: "CMS122",
  version: "v1.0",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 48,
  denominator: 45,
  compliant: 38,
  dueSoon: 0,
  overdue: 7,
  missingData: 0,
  excluded: 3,
  complianceRate: 84.4,
  openCaseCount: 7,
};
const point = (runId: string, startedAt: string, compliant: number, overdue: number) => ({
  runId, startedAt, complianceRate: null, totalEvaluated: 48, denominator: 45, compliant, dueSoon: 0, overdue, missingData: 0, excluded: 3,
});

function serve(dataInsufficient: string[] | null) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") {
      return Promise.resolve([{ id: "cms122", name: program.measureName, identity: { cmsId: "CMS122", improvementNotation: "decrease" } }]);
    }
    if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve([{ ...program, dataInsufficient }]);
    if (url.includes("/trend")) {
      return Promise.resolve([point("run-1", "2026-08-30T00:00:00Z", 38, 7), point("run-0", "2026-07-30T00:00:00Z", 36, 9)]);
    }
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    if (url.includes("/risk-outlook")) return Promise.resolve(null);
    return Promise.resolve([]);
  });
}

describe("ProgramDetailPage — a thin latest run states no rate (#853)", () => {
  beforeEach(() => serve(null));

  it("replaces the headline rate and the change from previous with the reason", async () => {
    serve(["encounterTypeCoded"]);
    render(<ProgramDetailPage />);
    expect(await screen.findByTestId("measure-thin")).toHaveTextContent("Data too thin to trust on the latest run");
    expect(screen.getByText("Poor control —")).toBeInTheDocument();
    expect(screen.queryByText("Poor control 15.6%")).toBeNull();
    expect(screen.queryByText(/from previous/)).toBeNull();
  });

  it("shows the rate and its change as before when the data met its floors", async () => {
    render(<ProgramDetailPage />);
    expect(await screen.findByText("Poor control 15.6%")).toBeInTheDocument();
    expect(await screen.findByText(/from previous/)).toBeInTheDocument();
    expect(screen.queryByTestId("measure-thin")).toBeNull();
  });
});
