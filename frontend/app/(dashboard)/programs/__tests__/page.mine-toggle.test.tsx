/**
 * The clinician's "Whole practice | My patients" toggle (#870). The cards are the whole practice; a
 * VIEWER whose sign-in is linked to a provider gets one step to that provider's own rates on the
 * scorecard. Nobody else sees it, and a case manager keeps "Rates by provider".
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => ({ siteId: "", from: "", to: "" }),
}));
const auth = vi.hoisted(() => ({ role: "ROLE_VIEWER" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: auth.role } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));
const mine = vi.hoisted(() => ({
  provider: null as { id: string; name: string; location: string } | null,
}));
vi.mock("@/features/panel/use-my-provider", () => ({
  useMyProvider: () => ({ provider: mine.provider, loaded: true, error: false, retry: () => {} }),
}));

import ProgramsPage from "../page";

const SILVA = { id: "maui-prov-011", name: "Dr. Ana Silva", location: "Wailuku" };
const PROGRAM = {
  measureId: "cms125",
  measureName: "Breast Cancer Screening",
  policyRef: "CMS125v14",
  version: "v1.0",
  latestRunId: "run-1",
  latestRunAt: "2026-09-30T12:03:00Z",
  totalEvaluated: 100,
  denominator: 100,
  compliant: 72,
  dueSoon: 0,
  overdue: 28,
  missingData: 0,
  excluded: 0,
  complianceRate: 72,
  openCaseCount: 28,
  measurementYear: 2026,
  asOf: "2026-09-30",
};

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_VIEWER";
  mine.provider = SILVA;
  get.mockReset().mockImplementation((url: string) => {
    if (url.includes("include=trend")) return Promise.resolve([{ ...PROGRAM, trend: [] }]);
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([PROGRAM]);
    return Promise.resolve([]);
  });
});

/** Rendered, with the overview painted, so an absent toggle is absent for its reason and not a race. */
async function renderPage() {
  render(<ProgramsPage />);
  await screen.findByText("Compliance 72.0%");
}

describe("ProgramsPage — whole practice or my patients (#870)", () => {
  it("gives a linked viewer the toggle, the whole practice pressed and their own patients one link away", async () => {
    await renderPage();
    const toggle = screen.getByTestId("programs-mine-toggle");
    const practice = within(toggle).getByRole("button", { name: "Whole practice" });
    expect(practice).toHaveAttribute("aria-pressed", "true");
    expect(within(toggle).queryByRole("link", { name: "Whole practice" })).toBeNull();
    const mineLink = within(toggle).getByRole("link", { name: "My patients: Dr. Ana Silva's rates beside the practice" });
    expect(mineLink).toHaveAttribute("href", "/scorecard");
    expect(mineLink).toHaveTextContent("My patients");
    // The case manager's link is not offered to a seat the full scorecard refuses.
    expect(screen.queryByTestId("programs-scorecard-link")).toBeNull();
  });

  it("gives an unlinked viewer neither the toggle nor the provider link", async () => {
    mine.provider = null;
    await renderPage();
    expect(screen.queryByTestId("programs-mine-toggle")).toBeNull();
    expect(screen.queryByTestId("programs-scorecard-link")).toBeNull();
  });

  it("keeps a case manager's Rates by provider, and no toggle, even were a provider named", async () => {
    // The hook names a provider only for a VIEWER (its own test); this is the page's order of the two.
    auth.role = "ROLE_CASE_MANAGER";
    await renderPage();
    expect(screen.queryByTestId("programs-mine-toggle")).toBeNull();
    expect(screen.getByTestId("programs-scorecard-link")).toHaveTextContent("Rates by provider");
  });

  it("shows nothing on the occupational deployment, linked or not", async () => {
    setSubject("employee");
    await renderPage();
    expect(screen.queryByTestId("programs-mine-toggle")).toBeNull();
    expect(screen.queryByTestId("programs-scorecard-link")).toBeNull();
  });
});
