import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
const auth = vi.hoisted(() => ({ role: "ROLE_CASE_MANAGER" }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

import ScorecardPage from "../page";

/**
 * The provider × measure scorecard (#852). jsdom renders BOTH layouts (the desktop table and the phone
 * cards), so each assertion is anchored inside one of them.
 */
const rate = (numer: number, effectiveDenominator: number, label: string | null = null) => ({
  label,
  numer,
  effectiveDenominator,
  score: effectiveDenominator > 0 ? numer / effectiveDenominator : null,
  smallNumber: effectiveDenominator < 20,
});
const cell = (rates: ReturnType<typeof rate>[] | null, openGaps: number | null = 0) => ({ rates, openGaps });

function scorecard(over: Record<string, unknown> = {}) {
  return {
    measurementYear: 2026,
    generatedAt: "2026-10-20T15:00:00.000Z",
    smallNumberThreshold: 20,
    openGapsShown: true,
    panel: { requested: "all", ownsPanel: false },
    measures: [
      { measureId: "cms125", name: "Breast Cancer Screening", state: "complete", runStartedAt: "2026-10-19T12:00:00.000Z", executedLogic: "CMS125FHIR v1.0.000", logic: null, numeratorMeansCompliant: true },
      { measureId: "cms122", name: "Diabetes: Glycemic Status", state: "data_insufficient", runStartedAt: "2026-10-19T12:00:00.000Z", executedLogic: null, logic: null, numeratorMeansCompliant: false },
    ],
    locations: [
      {
        location: "Wailuku Clinic",
        providers: [
          { providerId: "p-a", name: "Dr. A", cells: { cms125: cell([rate(30, 40)], 10), cms122: cell(null, 3) } },
          { providerId: "p-b", name: "Dr. B", cells: { cms125: cell([rate(5, 12)], 0), cms122: cell(null, 0) } },
        ],
        subtotal: { providerId: null, name: "Wailuku Clinic", cells: { cms125: cell([rate(35, 52)], 10), cms122: cell(null, 3) } },
      },
    ],
    other: null,
    total: { providerId: null, name: "Total", cells: { cms125: cell([rate(35, 52)], 10), cms122: cell(null, 3) } },
    ...over,
  };
}

function serve(card: unknown) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.startsWith("/api/scorecard")) return Promise.resolve(card);
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_CASE_MANAGER";
});

describe("ScorecardPage", () => {
  it("states each provider's rate with the counts behind it, and links their open gaps to the work list", async () => {
    serve(scorecard());
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    const [first] = within(table).getAllByTestId("scorecard-row-provider");
    expect(first).toHaveTextContent("Dr. A");
    expect(first).toHaveTextContent("75.0% (30 / 40)");
    expect(within(first!).getByRole("link", { name: "10 open" })).toHaveAttribute("href", "/worklist?measureId=cms125&providerId=p-a&panel=all");
    // The total is named for what it covers, and its counts are added, not averaged.
    expect(within(table).getByTestId("scorecard-row-total")).toHaveTextContent("Practice total");
    expect(within(table).getByTestId("scorecard-row-total")).toHaveTextContent("67.3% (35 / 52)");
  });

  it("dims a rate on fewer than 20 patients and says so", async () => {
    serve(scorecard());
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    const second = within(table).getAllByTestId("scorecard-row-provider")[1]!;
    expect(second).toHaveTextContent("41.7% (5 / 12)");
    expect(second).toHaveTextContent("fewer than 20 patients");
    expect(within(table).getAllByTestId("scorecard-row-provider")[0]).not.toHaveTextContent("fewer than 20");
  });

  it("shows no rate in a refused column, says why in its header, and still counts its open gaps", async () => {
    serve(scorecard());
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    expect(within(table).getByTestId("scorecard-refused-cms122")).toHaveTextContent("The run's data was too thin to trust");
    expect(within(table).getByText("Lower is better")).toBeInTheDocument();
    const first = within(table).getAllByTestId("scorecard-row-provider")[0]!;
    expect(within(first).getByRole("link", { name: "3 open" })).toHaveAttribute("href", "/worklist?measureId=cms122&providerId=p-a&panel=all");
  });

  it("gives the phone a card per provider with the same figures", async () => {
    serve(scorecard());
    render(<ScorecardPage />);
    const cards = await screen.findByTestId("scorecard-cards");
    const [first] = within(cards).getAllByTestId("scorecard-card-provider");
    expect(first).toHaveTextContent("Dr. A");
    expect(first).toHaveTextContent("75.0% (30 / 40)");
    expect(within(cards).getByTestId("scorecard-card-total")).toHaveTextContent("Practice total");
  });

  it("offers My providers only to someone who owns a panel, and asks the server for it", async () => {
    serve(scorecard());
    const { unmount } = render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    expect(screen.queryByRole("button", { name: "My providers" })).toBeNull();
    unmount();

    serve(scorecard({ panel: { requested: "all", ownsPanel: true } }));
    render(<ScorecardPage />);
    fireEvent.click(await screen.findByRole("button", { name: "My providers" }));
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(expect.stringContaining("panel=me")));
  });

  it("under My providers, the total's open gaps open the caller's panel, not the whole practice", async () => {
    serve(scorecard({ panel: { requested: "me", ownsPanel: true } }));
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    const total = within(table).getByTestId("scorecard-row-total");
    expect(total).toHaveTextContent("My providers");
    expect(within(total).getByRole("link", { name: "10 open" })).toHaveAttribute("href", "/worklist?measureId=cms125&panel=me");
  });

  it("gives the phone each location's subtotal after its providers", async () => {
    serve(scorecard());
    render(<ScorecardPage />);
    const cards = await screen.findByTestId("scorecard-cards");
    expect(within(cards).getByTestId("scorecard-card-subtotal")).toHaveTextContent("Wailuku Clinic subtotal");
    expect(within(cards).getByTestId("scorecard-card-subtotal")).toHaveTextContent("67.3% (35 / 52)");
  });

  it("with no rows to show, still says why each refused column has none", async () => {
    serve(scorecard({ locations: [], total: { providerId: null, name: "Total", cells: {} } }));
    render(<ScorecardPage />);
    expect(await screen.findByTestId("scorecard-empty-reasons")).toHaveTextContent("The run's data was too thin to trust");
  });

  it("refuses a role that cannot read it, without asking the server", () => {
    auth.role = "ROLE_VIEWER";
    serve(scorecard());
    render(<ScorecardPage />);
    expect(screen.getByText(/your role doesn.t have access/)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining("/api/scorecard"));
  });
});
