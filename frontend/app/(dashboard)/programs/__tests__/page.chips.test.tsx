import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
// Mutable so a test can activate a global site/date scope.
const filtersHolder = { value: { siteId: "", from: "", to: "" } };
vi.mock("@/components/global-filter-context", () => ({
  useGlobalFilters: () => filtersHolder.value,
}));
const auth = { role: "ROLE_ADMIN" };
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: auth.role } }),
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
};

beforeEach(() => {
  auth.role = "ROLE_ADMIN";
  filtersHolder.value = { siteId: "", from: "", to: "" };
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/programs/overview")) return Promise.resolve([program]);
    return Promise.resolve([]);
  });
});

describe("ProgramsPage status chips", () => {
  // A gap chip opens the work list, the case manager's daily screen (#698): one row per patient,
  // filtered to the measure and the status, so the click names each patient without re-filtering. The
  // chips used to open the Cases list (organised around case state), then the roster; the work list is
  // the patient-first list of open gaps the practice asked for.
  it("renders each gap chip as a deep link into the measure-scoped work list", async () => {
    render(<ProgramsPage />);
    const overdue = await screen.findByRole("link", { name: /overdue/i });
    expect(overdue).toHaveAttribute("href", "/worklist?measureId=cms125&outcome=OVERDUE&panel=all");
    expect(screen.getByRole("link", { name: /due soon/i })).toHaveAttribute(
      "href", "/worklist?measureId=cms125&outcome=DUE_SOON&panel=all");
    expect(screen.getByRole("link", { name: /missing data/i })).toHaveAttribute(
      "href", "/worklist?measureId=cms125&outcome=MISSING_DATA&panel=all");
    // Patients outside the measure's population are not the measure's concern and get no chip (#637).
    expect(screen.queryByRole("link", { name: /not in population/i })).toBeNull();
  });

  it("loads the page in TWO requests, not 1 + 2N — and paints on the first", async () => {
    // The page used to fire the overview, then a trend and a top-drivers call per measure — 13
    // requests on the pilot, each re-resolving the same winning runs before hitting the same memo.
    // Two rather than one: the overview is the cheap half, and painting it is what makes the page
    // feel loaded. A single include=detail call held the KPIs behind the slowest panel.
    render(<ProgramsPage />);
    await screen.findByRole("link", { name: /overdue/i });
    const programCalls = () => get.mock.calls.map(([url]) => url as string).filter((url) => url.startsWith("/api/programs"));

    // The card is on screen after the plain overview — the detail call has not been awaited for it.
    expect(programCalls()[0]).not.toContain("include=");
    await waitFor(() => expect(programCalls()).toHaveLength(2));
    expect(programCalls()[1]).toContain("include=trend");
    expect(programCalls().some((url) => url.includes("/top-drivers") || url.includes("/trend"))).toBe(false);
  });

  it("renders a zero chip, and still links it", async () => {
    // A count of zero is an answer, and an absent badge reads as broken rather than as "none".
    get.mockImplementation((url: string) =>
      url.startsWith("/api/programs/overview") ? Promise.resolve([{ ...program, overdue: 0 }]) : Promise.resolve([]));
    render(<ProgramsPage />);
    const overdue = await screen.findByRole("link", { name: /overdue 0/i });
    expect(overdue).toHaveAttribute("href", "/worklist?measureId=cms125&outcome=OVERDUE&panel=all");
  });

  it("keeps a role without the work list on the roster, for every chip", async () => {
    auth.role = "ROLE_VIEWER";
    render(<ProgramsPage />);
    expect(await screen.findByRole("link", { name: /overdue/i })).toHaveAttribute("href", "/compliance?measureId=cms125&status=OVERDUE");
    expect(screen.getByRole("link", { name: /missing data/i })).toHaveAttribute("href", "/compliance?measureId=cms125&status=MISSING_DATA");
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
    // Both destinations honour site; neither is asked for a date range, so from/to are deliberately
    // NOT forwarded — implying a scope the destination does not apply would break the "matches the
    // clicked count" rule in the other direction.
    expect(overdue).toHaveAttribute("href", "/worklist?measureId=cms125&outcome=OVERDUE&site=clinic-1&panel=all");
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

  it("renders complianceRate and small compliant / denominator text when denominator is present", async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith("/api/programs/overview")) {
        return Promise.resolve([{
          ...program,
          denominator: 8,
          complianceRate: 25.0,
        }]);
      }
      return Promise.resolve([]);
    });
    render(<ProgramsPage />);
    expect(await screen.findByText("Compliance 25.0%")).toBeInTheDocument();
    expect(screen.getByText("2 / 8")).toBeInTheDocument();
  });
});

describe("ProgramsPage gap chips and the work list (#698)", () => {
  it("opens the whole practice, never the viewer's own panel: the chip counted the practice", async () => {
    render(<ProgramsPage />);
    expect(await screen.findByRole("link", { name: /overdue/i })).toHaveAttribute("href", expect.stringContaining("panel=all"));
    expect(screen.getByRole("link", { name: /Open cases/ })).toHaveAttribute("href", expect.stringContaining("panel=all"));
  });

  it("keeps a role without the work list on Cases for Open cases", async () => {
    auth.role = "ROLE_VIEWER";
    render(<ProgramsPage />);
    expect(await screen.findByRole("link", { name: /Open cases/ })).toHaveAttribute("href", "/cases?measureId=cms125");
  });
});
