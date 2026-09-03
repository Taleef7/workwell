import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProgramsPage from "../page";

import { setPublicDemo } from "@/test/mocks/public-demo";

vi.mock("@/lib/public-demo", () => import("@/test/mocks/public-demo"));

let currentRole = "ROLE_CASE_MANAGER";
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/hooks", () => ({
  useApi: () => ({ get, post }),
}));

vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));

vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

const program = {
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125",
  version: "FHIR v1",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 10,
  compliant: 2,
  dueSoon: 2,
  overdue: 2,
  missingData: 2,
  excluded: 2,
  complianceRate: 20,
  openCaseCount: 6,
};

describe("ProgramsPage pilot mode controls", () => {
  beforeEach(() => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";
    get.mockImplementation((url: string) => {
      if (url.startsWith("/api/programs/overview")) return Promise.resolve([program]);
      if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
      if (url === "/api/tenants") return Promise.resolve([{ id: "t1", name: "Tenant 1" }]);
      return Promise.resolve([]);
    });
  });

  it("hides Run All Measures Now and System selector for non-admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_CASE_MANAGER";

    render(<ProgramsPage />);

    await waitFor(() => {
      expect(screen.getByText("Programs Overview")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /Run All Measures Now/i })).toBeNull();
    expect(screen.queryByLabelText("System")).toBeNull();
  });

  it("shows Run All Measures Now and System selector for admin in pilot mode", async () => {
    setPublicDemo(false);
    currentRole = "ROLE_ADMIN";

    render(<ProgramsPage />);

    await waitFor(() => {
      expect(screen.getByText("Programs Overview")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /Run All Measures Now/i })).toBeInTheDocument();
    expect(screen.getByLabelText("System")).toBeInTheDocument();
  });

  it("companion: shows controls for non-admin when PUBLIC_DEMO is true", async () => {
    setPublicDemo(true);
    currentRole = "ROLE_CASE_MANAGER";

    render(<ProgramsPage />);

    await waitFor(() => {
      expect(screen.getByText("Programs Overview")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /Run All Measures Now/i })).toBeInTheDocument();
    expect(screen.getByLabelText("System")).toBeInTheDocument();
  });
});

