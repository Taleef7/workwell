import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import ProgramDetailPage from "../page";

/**
 * #644: "Run This Measure" started a whole-practice run on one click, with no warning, and slowed every
 * page for ~15 minutes. It now asks first.
 */
const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/hooks", () => ({ useApi: () => ({ get, post }) }));
vi.mock("next/navigation", () => ({ useParams: () => ({ measureId: "cms125" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER" } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));

const program = {
  measureId: "cms125", measureName: "Breast Cancer Screening", policyRef: "CMS125", version: "v1.0",
  latestRunId: "run-1", latestRunAt: "2026-08-30T00:00:00Z", totalEvaluated: 10, compliant: 5, dueSoon: 2,
  overdue: 2, missingData: 1, excluded: 0, complianceRate: 50, openCaseCount: 4,
};

const runCalls = () => post.mock.calls.filter(([url]) => url === "/api/runs/manual");

describe("Run This Measure asks before starting a whole-practice run (#644)", () => {
  beforeEach(() => {
    setSubject("patient");
    post.mockReset().mockResolvedValue({ runId: "run-9", status: "REQUESTED" });
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.resolve([{ id: "cms125", name: "Breast Cancer Screening", identity: null }]);
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve([program]);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      return Promise.resolve([]);
    });
  });

  it("does nothing on the first click but explain the cost; Cancel starts nothing", async () => {
    render(<ProgramDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Run This Measure" }));

    expect(screen.getByText("Run this measure now?")).toBeInTheDocument();
    expect(screen.getByText(/about 15 minutes, and other pages are slower while it runs/)).toBeInTheDocument();
    expect(runCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(runCalls()).toHaveLength(0);
  });

  it("starts the run only when confirmed", async () => {
    render(<ProgramDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Run This Measure" }));
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => expect(runCalls()).toHaveLength(1));
    expect(runCalls()[0]![1]).toEqual({ scopeType: "MEASURE", measureId: "cms125" });
  });
});
