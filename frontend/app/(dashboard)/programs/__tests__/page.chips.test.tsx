import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
// Mutable so a test can activate a global site/date scope.
const filtersHolder = { value: { siteId: "", from: "", to: "" } };
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => filtersHolder.value,
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

import ProgramsPage from "../page";

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

beforeEach(() => {
  filtersHolder.value = { siteId: "", from: "", to: "" };
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([program]);
    if (url.includes("/top-drivers")) return Promise.resolve({ bySite: [], byRole: [], byOutcomeReason: [] });
    return Promise.resolve([]);
  });
});

describe("ProgramsPage status chips", () => {
  it("renders each actionable chip as a deep link into the pre-filtered cases list", async () => {
    render(<ProgramsPage />);
    const overdue = await screen.findByRole("link", { name: /overdue/i });
    expect(overdue).toHaveAttribute("href", "/cases?measureId=cms125&outcome=OVERDUE");
    expect(screen.getByRole("link", { name: /due soon/i })).toHaveAttribute(
      "href", "/cases?measureId=cms125&outcome=DUE_SOON");
    expect(screen.getByRole("link", { name: /missing data/i })).toHaveAttribute(
      "href", "/cases?measureId=cms125&outcome=MISSING_DATA");
  });

  it("links compliant and excluded chips to the measure-scoped compliance roster", async () => {
    render(<ProgramsPage />);
    await screen.findByRole("link", { name: /overdue/i });
    expect(screen.getByRole("link", { name: /: compliant/i })).toHaveAttribute(
      "href", "/compliance?measureId=cms125&status=COMPLIANT");
    expect(screen.getByRole("link", { name: /: excluded/i })).toHaveAttribute(
      "href", "/compliance?measureId=cms125&status=EXCLUDED");
  });

  it("renders the compliant and excluded chips with their labels and counts", async () => {
    render(<ProgramsPage />);
    await screen.findByRole("link", { name: /overdue/i });
    // The chip labels are always rendered as text (link or not); the deep-link test above pins
    // that Compliant/Excluded are now links, so these assertions just confirm the labels survive.
    expect(screen.getByText("Compliant 2")).toBeInTheDocument();
    expect(screen.getByText("Excluded 2")).toBeInTheDocument();
  });

  it("carries the active global site/date scope so the destination matches the clicked count", async () => {
    filtersHolder.value = { siteId: "clinic-1", from: "2026-01-01", to: "2026-06-30" };
    render(<ProgramsPage />);
    const overdue = await screen.findByRole("link", { name: /overdue/i });
    expect(overdue).toHaveAttribute(
      "href",
      "/cases?measureId=cms125&outcome=OVERDUE&site=clinic-1&from=2026-01-01&to=2026-06-30",
    );
    expect(screen.getByRole("link", { name: /: compliant/i })).toHaveAttribute(
      "href",
      "/compliance?measureId=cms125&status=COMPLIANT&site=clinic-1",
    );
    expect(screen.getByRole("link", { name: /: excluded/i })).toHaveAttribute(
      "href",
      "/compliance?measureId=cms125&status=EXCLUDED&site=clinic-1",
    );
  });

  it("names each chip with its measure and stacks it above the card overlay", async () => {
    render(<ProgramsPage />);
    const overdue = await screen.findByRole("link", { name: "Breast Cancer Screening: Overdue 2" });
    // jsdom has no stacking contexts, so the property that makes the chip clickable at all —
    // sitting above the card's stretched absolute-inset-0 overlay Link — is pinned by class.
    expect(overdue.className).toContain("z-10");
  });
});
