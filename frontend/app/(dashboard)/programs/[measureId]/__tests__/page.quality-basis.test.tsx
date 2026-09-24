import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProgramDetailPage from "../page";
import { ApiError } from "@/lib/api/errors";

// #642: the "Quality over time" panel read /api/quality/history directly and showed 17.3% under a
// 41.9% headline, captioned "(source of truth)". The server now refuses that series (409) for a
// measure whose snapshots would understate its rate; the panel must say so and show no number.

const get = vi.fn();
vi.mock("@/lib/api/hooks", () => ({ useApi: () => ({ get }) }));
vi.mock("next/navigation", () => ({ useParams: () => ({ measureId: "cms130" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

const REFUSAL =
  "Monthly history is not available for this measure. The stored monthly snapshots count patients outside the measure's population in the denominator, so they would show a lower rate than the measure's real one. The trend chart on this page uses the corrected basis.";

const program = {
  measureId: "cms130",
  measureName: "Colorectal Cancer Screening",
  policyRef: "CMS130",
  version: "v1.0",
  latestRunId: "run-1",
  latestRunAt: "2026-09-22T00:00:00Z",
  totalEvaluated: 20000,
  denominator: 8093,
  compliant: 3388,
  dueSoon: 0,
  overdue: 4705,
  missingData: 0,
  excluded: 0,
  complianceRate: 41.9,
  openCaseCount: 4705,
};

function mockApi(history: () => Promise<unknown>) {
  get.mockImplementation((raw: unknown) => {
    const url = typeof raw === "string" ? raw : "";
    if (url === "/api/measures") {
      return Promise.resolve([{ id: "cms130", name: "Colorectal Cancer Screening", identity: { cmsId: "CMS130", improvementNotation: "increase" } }]);
    }
    if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve([program]);
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    if (url.includes("/risk-outlook")) return Promise.resolve(null);
    if (url.includes("/quality/history")) return history();
    return Promise.resolve([]);
  });
}

describe("Quality over time — the snapshot basis (#642)", () => {
  beforeEach(() => get.mockReset());

  it("shows the server's refusal, and no rate, when the monthly series would understate the measure", async () => {
    mockApi(() => Promise.reject(new ApiError(409, JSON.stringify({ error: "snapshot_basis_unsafe", message: REFUSAL }), REFUSAL)));
    render(<ProgramDetailPage />);
    const note = await screen.findByText(/Monthly history is not available for this measure/);
    expect(note.closest("[role=note]")).not.toBeNull();
    // The absence copy is for a DIFFERENT case and must not appear beside the refusal.
    expect(screen.queryByText(/No materialized quality snapshots yet/)).not.toBeInTheDocument();
    // The scope selector is hidden too: the refusal is about the measure, not one scope of it.
    expect(screen.queryByRole("combobox", { name: /Scope/ })).not.toBeInTheDocument();
  });

  it("no longer calls the panel the source of truth", async () => {
    mockApi(() => Promise.resolve([]));
    render(<ProgramDetailPage />);
    await waitFor(() => expect(screen.getByText(/Quality over time/)).toBeInTheDocument());
    expect(await screen.findByText(/No monthly history yet/)).toBeInTheDocument();
    expect(screen.queryByText(/source of truth/i)).not.toBeInTheDocument();
  });

  it("a failure that is not THIS refusal — a 500, or some other 409 — is shown as a failure, never as 'no data' or a basis problem", async () => {
    for (const err of [
      new ApiError(500, "", "Request failed (500)"),
      new ApiError(409, JSON.stringify({ error: "something_else", message: "Other conflict" }), "Other conflict"),
    ]) {
      mockApi(() => Promise.reject(err));
      const { unmount } = render(<ProgramDetailPage />);
      await waitFor(() => expect(get).toHaveBeenCalledWith(expect.stringContaining("/quality/history")));
      expect(await screen.findByText(`Monthly history could not be loaded (${err.message}). Try again shortly.`)).toBeInTheDocument();
      expect(screen.queryByText(/No materialized quality snapshots yet/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Monthly history is not available/)).not.toBeInTheDocument();
      unmount();
    }
  });
});
