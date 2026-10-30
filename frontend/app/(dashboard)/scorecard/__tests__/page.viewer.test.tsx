import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";
import type { MyProvider } from "@/features/panel/use-my-provider";
import { ApiError } from "@/lib/api/errors";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
const auth = vi.hoisted(() => ({ role: "ROLE_VIEWER", email: "clinician@maui.workwell.dev" }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: auth.role, email: auth.email } }) }));

/** What `useMyProvider` answers, changed per test. */
const myProvider = vi.hoisted(() => ({
  provider: null as MyProvider | null,
  loaded: true,
  error: false,
  retry: (() => {}) as () => void,
}));
vi.mock("@/features/panel/use-my-provider", () => ({ useMyProvider: () => myProvider }));

const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/scorecard");
  return navHolder.current.navigation;
});

import ScorecardPage from "../page";

/**
 * A clinician's own scorecard (#870): a VIEWER linked to a provider reads their row beside the practice
 * total, and nothing else. jsdom renders BOTH layouts (the desktop table and the phone cards), so each
 * assertion is anchored inside one of them.
 */
const SILVA: MyProvider = { id: "maui-prov-011", name: "Dr. Ana Silva", location: "Wailuku Clinic" };
const UNLINKED = /isn.t linked to a provider in this practice.s directory/;

const rate = (numer: number, effectiveDenominator: number, label: string | null = null, ipp = effectiveDenominator) => ({
  label,
  ipp,
  numer,
  effectiveDenominator,
  score: effectiveDenominator > 0 ? numer / effectiveDenominator : null,
  smallNumber: effectiveDenominator < 20,
});
const cell = (rates: ReturnType<typeof rate>[] | null, openGaps: number | null = 0) => ({ rates, openGaps });

const measure = (measureId: string, name: string, over: Record<string, unknown> = {}) => ({
  measureId,
  name,
  state: "complete",
  runStartedAt: "2026-10-19T12:00:00.000Z",
  executedLogic: null,
  logic: null,
  numeratorMeansCompliant: true,
  ...over,
});

/** A linked VIEWER's card as the server states it: no locations, no Other, the whole practice's total. */
function viewerCard(over: Record<string, unknown> = {}) {
  return {
    measurementYear: 2026,
    generatedAt: "2026-10-20T15:00:00.000Z",
    smallNumberThreshold: 20,
    openGapsShown: true,
    panel: { requested: "all", ownsPanel: false },
    measures: [
      measure("cms125", "Breast Cancer Screening", { executedLogic: "CMS125FHIR v1.0.000" }),
      // Diabetes: the numerator is poor control, so a high rate is the bad one.
      measure("cms122", "Diabetes: Glycemic Status", { numeratorMeansCompliant: false }),
    ],
    locations: [],
    other: null,
    total: { providerId: null, name: "Total", cells: { cms125: cell([rate(350, 520)], 12), cms122: cell([rate(40, 300)], 5) } },
    scope: {
      providerId: SILVA.id,
      name: SILVA.name,
      location: SILVA.location,
      row: { providerId: SILVA.id, name: SILVA.name, cells: { cms125: cell([rate(30, 40)], 10), cms122: cell([rate(3, 12)], 1) } },
    },
    ...over,
  };
}

/**
 * The same card carrying the rows a practice card has. A real VIEWER answer never does; this is what
 * proves the view draws the clinician's row and the total ONLY, rather than whatever the card holds.
 */
function cardWithPracticeRows() {
  return viewerCard({
    locations: [
      {
        location: "Wailuku Clinic",
        providers: [{ providerId: "p-b", name: "Dr. B", cells: { cms125: cell([rate(5, 12)], 3), cms122: cell([rate(1, 9)], 0) } }],
        subtotal: { providerId: null, name: "Wailuku Clinic", cells: { cms125: cell([rate(35, 52)], 13), cms122: cell([rate(4, 34)], 1) } },
      },
    ],
    other: { providerId: null, name: "Other", cells: { cms125: cell([rate(1, 3)], 0), cms122: cell(null, 0) } },
  });
}

function serve(card: unknown) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.startsWith("/api/scorecard")) return Promise.resolve(card);
    if (url.startsWith("/api/panels")) return Promise.resolve([]);
    return Promise.resolve([]);
  });
}

const calls = (): string[] => get.mock.calls.map((c) => String(c[0]));
const scorecardCalls = (): string[] => calls().filter((u) => u.startsWith("/api/scorecard"));
/** Both deferred reads (the scorecard's and any other) have had their tick. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
/** What the desktop table draws, top to bottom: every row's name. */
const tableNames = () => Array.from(screen.getByTestId("scorecard-table").querySelectorAll("tbody th")).map((th) => th.textContent);
const cardFor = (label: RegExp) =>
  within(screen.getByTestId("scorecard-cards"))
    .getAllByTestId("scorecard-card-measure")
    .find((c) => label.test(within(c).getByRole("heading", { level: 3 }).textContent ?? ""))!;

const thisYear = new Date().getUTCFullYear();

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_VIEWER";
  myProvider.provider = SILVA;
  myProvider.loaded = true;
  myProvider.error = false;
  myProvider.retry = vi.fn();
  navHolder.current.setUrl("/scorecard");
  navHolder.current.replace.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a clinician's scorecard", () => {
  it("asks once, for the year alone, and never for panel mappings", async () => {
    serve(viewerCard());
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    await settle();
    expect(scorecardCalls()).toEqual([`/api/scorecard?measurementYear=${thisYear}`]);
    expect(calls().some((u) => u.startsWith("/api/panels"))).toBe(false);
  });

  it("draws the clinician's row and the practice total, says what each covers, and offers the whole practice", async () => {
    serve(viewerCard());
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    expect(screen.getByRole("heading", { level: 2, name: "Your patients — Dr. Ana Silva" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "CMS measure rates for patients whose PCP on file is Dr. Ana Silva, beside the whole practice (all sites). Programs cards show the work-list rate, so the practice figure here can differ.",
      ),
    ).toBeInTheDocument();
    expect(tableNames()).toEqual(["Dr. Ana Silva (you)", "Practice total (all sites)"]);
    expect(within(table).getByTestId("scorecard-row-mine")).toHaveTextContent("75.0% (30 / 40)");
    expect(within(table).getByTestId("scorecard-row-total")).toHaveTextContent("67.3% (350 / 520)");

    const toggle = screen.getByRole("group", { name: "Which patients" });
    expect(within(toggle).getByRole("button", { name: "My patients" })).toHaveAttribute("aria-pressed", "true");
    expect(within(toggle).getByRole("link", { name: "Whole practice" })).toHaveAttribute("href", "/programs");
    // No provider picker: the card holds no other provider to pick.
    expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  });

  it("draws only its own row and the total, in both layouts, even from a card carrying a practice's rows", async () => {
    serve(cardWithPracticeRows());
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    expect(tableNames()).toEqual(["Dr. Ana Silva (you)", "Practice total (all sites)"]);
    for (const kind of ["subtotal", "provider", "other"]) {
      expect(within(table).queryByTestId(`scorecard-row-${kind}`)).toBeNull();
      expect(screen.queryByTestId(`scorecard-card-${kind}`)).toBeNull();
    }
    expect(screen.queryByText(/Dr\. B/)).toBeNull();
    expect(screen.queryByText(/subtotal/)).toBeNull();
    // The phone: one card per measure, the clinician's line and the practice's.
    const cards = within(screen.getByTestId("scorecard-cards")).getAllByTestId("scorecard-card-measure");
    expect(cards).toHaveLength(2);
    const breast = cardFor(/CMS125|Breast/);
    expect(Array.from(breast.querySelectorAll("dt")).map((dt) => dt.textContent)).toEqual(["You", "Practice"]);
    expect(breast).toHaveTextContent("75.0% (30 / 40)");
    expect(breast).toHaveTextContent("67.3% (350 / 520)");
  });

  it("states open gaps as a count and links nothing to the work list", async () => {
    serve(viewerCard());
    const { container } = render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    const mine = within(table).getByTestId("scorecard-row-mine");
    expect(mine).toHaveTextContent("10 open gaps");
    expect(mine).toHaveTextContent("1 open gap");
    expect(within(table).getByTestId("scorecard-row-total")).toHaveTextContent("12 open gaps");
    expect(container.querySelectorAll('a[href*="/worklist"]')).toHaveLength(0);
    expect(within(table).queryAllByRole("link")).toHaveLength(0);
  });

  it("dims a rate on fewer than 20 patients as the practice scorecard does", async () => {
    serve(viewerCard());
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    // Own: 30 / 40 is not dimmed, 3 / 12 is.
    const [enough, few] = within(table).getByTestId("scorecard-row-mine").querySelectorAll("td");
    expect(enough).not.toHaveTextContent("fewer than 20");
    expect(few).toHaveTextContent("fewer than 20 patients");
    expect(few!.querySelector(".text-neutral-400")).toHaveTextContent("25.0% (3 / 12)");
    expect(within(table).getByTestId("scorecard-row-total")).not.toHaveTextContent("fewer than 20");
  });

  it("ignores a provider or panel in the address", async () => {
    navHolder.current.setUrl("/scorecard?provider=p-zz&panel=me");
    serve(viewerCard());
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    expect(tableNames()).toEqual(["Dr. Ana Silva (you)", "Practice total (all sites)"]);
    expect(screen.queryByTestId("scorecard-provider-missing")).toBeNull();
    await settle();
    expect(scorecardCalls()).toEqual([`/api/scorecard?measurementYear=${thisYear}`]);
  });

  it("says None of yours where a complete column counted none of the clinician's patients", async () => {
    const base = viewerCard();
    serve(
      viewerCard({
        scope: { ...base.scope, row: { ...base.scope.row, cells: { cms125: cell([rate(0, 0)], 0), cms122: cell([rate(3, 12)], 1) } } },
      }),
    );
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    const mine = within(table).getByTestId("scorecard-row-mine");
    expect(mine).toHaveTextContent("None of yours");
    expect(mine).not.toHaveTextContent("(0 / 0)");
    expect(within(table).getByTestId("scorecard-row-total")).not.toHaveTextContent("None of yours");
    expect(cardFor(/CMS125|Breast/)).toHaveTextContent("None of yours");
    expect(cardFor(/CMS122|Diabetes/)).not.toHaveTextContent("None of yours");
  });

  it("does not say None of yours where a patient of theirs could not be scored", async () => {
    const base = viewerCard();
    const unscored = { ...cell([rate(0, 0)], 0), buckets: { scored: 0, unmeasured: 0, evaluationErrors: 1, outOfPopulation: 2 } };
    serve(viewerCard({ scope: { ...base.scope, row: { ...base.scope.row, cells: { cms125: unscored, cms122: cell([rate(3, 12)], 1) } } } }));
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    expect(within(table).getByTestId("scorecard-row-mine")).not.toHaveTextContent("None of yours");
  });

  it("keeps the counts where every one of the clinician's patients in the measure was excluded", async () => {
    const base = viewerCard();
    serve(
      viewerCard({
        scope: { ...base.scope, row: { ...base.scope.row, cells: { cms125: cell([rate(0, 0, null, 4)], 0), cms122: cell([rate(3, 12)], 1) } } },
      }),
    );
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    const mine = within(table).getByTestId("scorecard-row-mine");
    expect(mine).not.toHaveTextContent("None of yours");
    expect(mine).toHaveTextContent("(0 / 0)");
  });

  it("marks the measure where lower is better: in the table's header, and on the phone before each rate", async () => {
    serve(
      viewerCard({
        measures: [
          measure("cms125", "Breast Cancer Screening"),
          measure("cms122", "Diabetes: Glycemic Status", { numeratorMeansCompliant: false }),
          // Inverse but refused: no rate, so nothing to call poor control.
          measure("cms999", "Inverse Refused", { numeratorMeansCompliant: false, state: "data_insufficient" }),
        ],
      }),
    );
    render(<ScorecardPage />);
    const table = await screen.findByTestId("scorecard-table");
    expect(within(table).getAllByText("Lower is better")).toHaveLength(2);
    const diabetes = cardFor(/CMS122|Diabetes/);
    expect(diabetes).toHaveTextContent("Poor control 25.0% (3 / 12)");
    expect(diabetes).toHaveTextContent("Poor control 13.3% (40 / 300)");
    expect(cardFor(/CMS125|Breast/)).not.toHaveTextContent("Poor control");
    const refused = cardFor(/CMS999|Inverse/);
    expect(refused).not.toHaveTextContent("Poor control");
    expect(refused).toHaveTextContent("The run's data was too thin to trust");
  });

  it("with no run for the year, gives the reasons and offers the year before", async () => {
    serve(
      viewerCard({
        measures: [measure("cms125", "Breast Cancer Screening", { state: "no_run", runStartedAt: null }), measure("cms122", "Diabetes: Glycemic Status", { state: "no_run", runStartedAt: null, numeratorMeansCompliant: false })],
      }),
    );
    render(<ScorecardPage />);
    const empty = await screen.findByTestId("scorecard-empty");
    expect(within(empty).getByTestId("scorecard-empty-reasons")).toHaveTextContent("No run for this year yet");
    expect(within(empty).getByRole("link", { name: "See 2025" })).toHaveAttribute("href", "/scorecard?year=2025");
    expect(screen.queryByTestId("scorecard-table")).toBeNull();
  });

  it("asks for another year when one is chosen, still without a panel", async () => {
    serve(viewerCard());
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    fireEvent.change(screen.getByRole("combobox", { name: "Measurement year" }), { target: { value: String(thisYear - 1) } });
    expect(navHolder.current.replace).toHaveBeenLastCalledWith(`/scorecard?year=${thisYear - 1}`, { scroll: false });
    await waitFor(() => expect(scorecardCalls().at(-1)).toBe(`/api/scorecard?measurementYear=${thisYear - 1}`));
    expect(scorecardCalls().every((u) => !u.includes("panel"))).toBe(true);
  });

  it("says why a slow read is slow", async () => {
    vi.useFakeTimers();
    get.mockReset().mockImplementation((url: string) => (url.startsWith("/api/scorecard") ? new Promise(() => {}) : Promise.resolve([])));
    render(<ScorecardPage />);
    expect(screen.queryByText(/can take about 15 seconds/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(screen.getByText(/can take about 15 seconds/)).toBeInTheDocument();
  });
});

describe("before and without a link", () => {
  it("waits while the link is being read, and refuses nothing yet", async () => {
    myProvider.provider = null;
    myProvider.loaded = false;
    serve(viewerCard());
    render(<ScorecardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    await settle();
    expect(screen.queryByText(UNLINKED)).toBeNull();
    expect(screen.queryByText(/your role doesn.t have access/)).toBeNull();
    expect(scorecardCalls()).toHaveLength(0);
  });

  it("refuses an unlinked clinician without asking for the scorecard", async () => {
    myProvider.provider = null;
    serve(viewerCard());
    render(<ScorecardPage />);
    expect(await screen.findByText(UNLINKED)).toBeInTheDocument();
    await settle();
    expect(scorecardCalls()).toHaveLength(0);
    expect(calls().some((u) => u.startsWith("/api/panels"))).toBe(false);
  });

  it("offers a retry when the link could not be read, and never calls that unlinked", async () => {
    myProvider.provider = null;
    myProvider.error = true;
    serve(viewerCard());
    render(<ScorecardPage />);
    expect(await screen.findByText("Couldn't check which provider your sign-in is linked to.")).toBeInTheDocument();
    expect(screen.queryByText(UNLINKED)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(myProvider.retry).toHaveBeenCalledTimes(1);
    await settle();
    expect(scorecardCalls()).toHaveLength(0);
  });

  it("refuses as unlinked when the server answers 403, not with the raw error", async () => {
    get.mockReset().mockImplementation((url: string) =>
      url.startsWith("/api/scorecard")
        ? Promise.reject(new ApiError(403, JSON.stringify({ error: "forbidden", reason: "no_linked_provider" }), "You don't have permission to perform this action."))
        : Promise.resolve([]),
    );
    render(<ScorecardPage />);
    expect(await screen.findByText(UNLINKED)).toBeInTheDocument();
    expect(screen.queryByText(/permission to perform/)).toBeNull();
    expect(screen.queryByTestId("scorecard-table")).toBeNull();
  });

  const UNAVAILABLE = "The scorecard didn't load. It can take a minute just after an update; try again.";

  it("says in words when the scorecard never answered, and Retry asks again", async () => {
    const card = viewerCard();
    let failures = 1;
    get.mockReset().mockImplementation((url: string) => {
      if (!url.startsWith("/api/scorecard")) return Promise.resolve([]);
      return failures-- > 0 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(card);
    });
    render(<ScorecardPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE);
    expect(screen.queryByText("Failed to fetch")).toBeNull();
    expect(scorecardCalls()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("scorecard-table")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(scorecardCalls()).toEqual([`/api/scorecard?measurementYear=${thisYear}`, `/api/scorecard?measurementYear=${thisYear}`]);
  });

  it("never shows a proxy's timeout page as the error", async () => {
    const page = "<html><head><title>504 Gateway Time-out</title></head></html>";
    get.mockReset().mockImplementation((url: string) =>
      url.startsWith("/api/scorecard") ? Promise.reject(new ApiError(504, page, page)) : Promise.resolve([]),
    );
    render(<ScorecardPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE);
    expect(screen.queryByText(/Gateway Time-out/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
