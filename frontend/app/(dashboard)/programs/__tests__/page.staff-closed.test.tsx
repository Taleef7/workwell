import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  notInPopulation: 3,
  excluded: 2,
  complianceRate: 20,
  openCaseCount: 6,
  staffClosedGapCount: 0,
};

const mockOverview = (over: Partial<typeof program>) => {
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([{ ...program, ...over }]);
    return Promise.resolve([]);
  });
};

beforeEach(() => mockOverview({}));

describe("ProgramsPage — the staff-closed reconciliation (#569)", () => {
  // The contradiction: the Overdue chip counts a patient an operator marked resolved (CQL still
  // counts them) while the open-case link does not. Both numbers were right and they disagreed with
  // nothing on the card accounting for it.
  it("links the count to the cases list's own Closed-by-staff tab, NOT to the roster", async () => {
    mockOverview({ staffClosedGapCount: 4 });
    render(<ProgramsPage />);

    const link = await screen.findByRole("link", { name: /closed by staff, still counted: 4/i });
    // The cases list, because that is where a closed case can be read. Every status chip on this card
    // goes to the roster, where these patients still appear as plain gaps — sending the
    // reconciliation there would land a reader on the surface that shows the contradiction.
    expect(link).toHaveAttribute("href", "/cases?status=staff_closed&measureId=cms125");
  });

  it("hides the count at zero, so a row of zeroes does not teach a reader to stop looking", async () => {
    render(<ProgramsPage />);
    await screen.findByRole("link", { name: /overdue/i });
    expect(screen.queryByText(/closed by staff/i)).not.toBeInTheDocument();
  });

  it("is absent rather than NaN when an older backend does not send the field", async () => {
    // The field is optional in the mirror: a frontend deployed ahead of the backend must not render
    // "still counted: undefined" beside a real number.
    const withoutField: Record<string, unknown> = { ...program };
    delete withoutField.staffClosedGapCount;
    get.mockReset().mockImplementation((url: string) =>
      url.startsWith("/api/programs/overview") ? Promise.resolve([withoutField]) : Promise.resolve([]),
    );
    render(<ProgramsPage />);
    await screen.findByRole("link", { name: /overdue/i });
    expect(screen.queryByText(/closed by staff/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN|undefined/)).not.toBeInTheDocument();
  });

  it("leaves the open-case link and the status chips exactly as they were", async () => {
    mockOverview({ staffClosedGapCount: 4 });
    render(<ProgramsPage />);
    // The two numbers sit side by side and describe different sets; neither moved.
    expect(await screen.findByRole("link", { name: /open worklist \(6\)/i })).toHaveAttribute(
      "href", "/cases?measureId=cms125");
    expect(screen.getByRole("link", { name: /overdue/i })).toHaveAttribute(
      "href", "/compliance?measureId=cms125&status=OVERDUE");
  });
});
