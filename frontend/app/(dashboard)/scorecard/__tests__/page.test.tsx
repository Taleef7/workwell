import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
const auth = vi.hoisted(() => ({ role: "ROLE_CASE_MANAGER", email: "quality-staff@maui.workwell.dev" }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: auth.role, email: auth.email } }) }));
const VIEWER_EMAIL = auth.email;

const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/scorecard");
  return navHolder.current.navigation;
});

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

/** A second location and an "Other" row, so narrowing to one provider has something to drop. */
function twoLocations() {
  const base = scorecard();
  return scorecard({
    locations: [
      ...base.locations,
      {
        location: "Kihei Clinic",
        providers: [{ providerId: "p-c", name: "Dr. C", cells: { cms125: cell([rate(8, 25)], 2), cms122: cell(null, 1) } }],
        subtotal: { providerId: null, name: "Kihei Clinic", cells: { cms125: cell([rate(8, 25)], 2), cms122: cell(null, 1) } },
      },
    ],
    other: { providerId: null, name: "Other", cells: { cms125: cell([rate(1, 3)], 0), cms122: cell(null, 0) } },
    total: { providerId: null, name: "Total", cells: { cms125: cell([rate(44, 80)], 12), cms122: cell(null, 4) } },
  });
}

/** A `/api/panels` row; owned by the signed-in viewer unless another assignee is given. */
const panelRow = (assignee: string | null = VIEWER_EMAIL) => ({
  providerId: "p-a",
  providerName: "Dr. A",
  location: "Wailuku Clinic",
  patients: 40,
  assignee,
  updatedAt: null,
});

function serve(card: unknown, panels: unknown[] = []) {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.startsWith("/api/scorecard")) return Promise.resolve(card);
    if (url.startsWith("/api/panels")) return Promise.resolve(panels);
    return Promise.resolve([]);
  });
}

const scorecardCalls = (): string[] => get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/scorecard"));
/** What the desktop table draws, top to bottom: each location's heading and every row's name. */
const tableNames = () => Array.from(screen.getByTestId("scorecard-table").querySelectorAll("tbody th")).map((th) => th.textContent);
/** What the phone draws, top to bottom: each card's title. */
const cardNames = () => within(screen.getByTestId("scorecard-cards")).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

beforeEach(() => {
  setSubject("patient");
  auth.role = "ROLE_CASE_MANAGER";
  navHolder.current.setUrl("/scorecard");
  navHolder.current.replace.mockClear();
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

  it("refuses a role that cannot read it, without asking the server", async () => {
    auth.role = "ROLE_VIEWER";
    serve(scorecard());
    render(<ScorecardPage />);
    expect(screen.getByText(/your role doesn.t have access/)).toBeInTheDocument();
    // Both reads are deferred a tick, so an assertion made straight after render would pass whether or
    // not they were gated. Let the timers run first.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining("/api/scorecard"));
    expect(get).not.toHaveBeenCalledWith("/api/panels");
  });
});

describe("the provider picker", () => {
  it("narrows both layouts to the chosen provider, their location's subtotal and the total, and puts the choice in the URL", async () => {
    serve(twoLocations());
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    expect(tableNames()).toEqual(["Wailuku Clinic", "Dr. A", "Dr. B", "Wailuku Clinic subtotal", "Kihei Clinic", "Dr. C", "Kihei Clinic subtotal", "Other", "Practice total"]);

    await userEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    // "Other" is the patients whose PCP the directory does not list, not a provider, so it is not offered.
    expect(within(screen.getByRole("listbox", { name: "Provider" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All providers",
      "Dr. A — Wailuku Clinic",
      "Dr. B — Wailuku Clinic",
      "Dr. C — Kihei Clinic",
    ]);
    await userEvent.click(screen.getByRole("option", { name: "Dr. B — Wailuku Clinic" }));

    expect(navHolder.current.replace).toHaveBeenLastCalledWith("/scorecard?provider=p-b", { scroll: false });
    await waitFor(() => expect(tableNames()).toEqual(["Wailuku Clinic", "Dr. B", "Wailuku Clinic subtotal", "Practice total"]));
    expect(cardNames()).toEqual(["Dr. B", "Wailuku Clinic subtotal", "Practice total"]);
    // The subtotal and the total are the server's, still over everyone they covered: the provider reads
    // against their location and the practice, not against totals rebuilt from one row.
    const table = screen.getByTestId("scorecard-table");
    expect(within(table).getByTestId("scorecard-row-subtotal")).toHaveTextContent("67.3% (35 / 52)");
    expect(within(table).getByTestId("scorecard-row-total")).toHaveTextContent("55.0% (44 / 80)");
    expect(within(screen.getByTestId("scorecard-cards")).getByTestId("scorecard-card-total")).toHaveTextContent("55.0% (44 / 80)");
    // A filter over the card in hand: nothing new is asked of the server.
    expect(scorecardCalls()).toHaveLength(1);

    // "All providers" takes the parameter out rather than spelling an empty one.
    await userEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    await userEvent.click(screen.getByRole("option", { name: "All providers" }));
    expect(navHolder.current.params.get("provider")).toBeNull();
    await waitFor(() => expect(cardNames()).toHaveLength(7));
  });

  it("opens narrowed from a link, and keeps the provider when the year changes", async () => {
    navHolder.current.setUrl("/scorecard?provider=p-b");
    serve(twoLocations());
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    expect(tableNames()).toEqual(["Wailuku Clinic", "Dr. B", "Wailuku Clinic subtotal", "Practice total"]);
    expect(cardNames()).toEqual(["Dr. B", "Wailuku Clinic subtotal", "Practice total"]);
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("Dr. B — Wailuku Clinic");

    const lastYear = new Date().getUTCFullYear() - 1;
    fireEvent.change(screen.getByRole("combobox", { name: "Measurement year" }), { target: { value: String(lastYear) } });
    expect(navHolder.current.params.get("year")).toBe(String(lastYear));
    expect(navHolder.current.params.get("provider")).toBe("p-b");
    await waitFor(() => expect(scorecardCalls().at(-1)).toContain(`measurementYear=${lastYear}`));
  });

  it("keeps a provider the card does not hold, says so instead of drawing everyone, and offers the way back", async () => {
    navHolder.current.setUrl("/scorecard?provider=p-zz");
    serve(scorecard());
    render(<ScorecardPage />);
    const notice = await screen.findByTestId("scorecard-provider-missing");
    expect(notice).toHaveTextContent("This provider is not in this view");
    // Rows for everyone under a link that named one provider would read as that provider's figures.
    expect(screen.queryByTestId("scorecard-table")).toBeNull();
    expect(screen.queryByTestId("scorecard-cards")).toBeNull();
    expect(navHolder.current.params.get("provider")).toBe("p-zz");

    await userEvent.click(within(notice).getByRole("button", { name: "Show all providers" }));
    expect(navHolder.current.params.get("provider")).toBeNull();
    await screen.findByTestId("scorecard-table");
    expect(tableNames()).toEqual(["Wailuku Clinic", "Dr. A", "Dr. B", "Wailuku Clinic subtotal", "Practice total"]);
    expect(screen.queryByTestId("scorecard-provider-missing")).toBeNull();
  });
});

describe("the default view and the URL", () => {
  it("opens on My providers for someone who owns a panel, without asking for the whole practice first", async () => {
    serve(scorecard({ panel: { requested: "me", ownsPanel: true } }), [panelRow()]);
    render(<ScorecardPage />);
    await waitFor(() => expect(scorecardCalls().length).toBeGreaterThan(0));
    // The FIRST request, not merely some request: loading before the mappings resolve asked for the whole
    // practice and then replaced it.
    expect(scorecardCalls()[0]).toContain("panel=me");
    expect(await screen.findByRole("button", { name: "My providers" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens on the whole practice for someone who owns none", async () => {
    serve(scorecard(), [panelRow("quality-lead@maui.workwell.dev")]);
    render(<ScorecardPage />);
    // Wait for the MAPPINGS, so the assertion is about the decision rather than a request made before it.
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/panels"));
    await waitFor(() => expect(scorecardCalls().length).toBeGreaterThan(0));
    expect(scorecardCalls()[0]).toContain("panel=all");
    expect(scorecardCalls().every((u) => !u.includes("panel=me"))).toBe(true);
  });

  it("honours an explicit whole-practice link even for someone who owns a panel", async () => {
    navHolder.current.setUrl("/scorecard?panel=all");
    serve(scorecard({ panel: { requested: "all", ownsPanel: true } }), [panelRow()]);
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/panels"));
    expect(scorecardCalls().every((u) => u.includes("panel=all"))).toBe(true);
    expect(navHolder.current.params.get("panel")).toBe("all");
  });

  it("asks for the year the URL names, and for this year when the URL's is not one", async () => {
    navHolder.current.setUrl("/scorecard?year=2025");
    serve(scorecard({ measurementYear: 2025 }));
    const { unmount } = render(<ScorecardPage />);
    await waitFor(() => expect(scorecardCalls().length).toBeGreaterThan(0));
    expect(scorecardCalls()[0]).toContain("measurementYear=2025");
    expect(screen.getByRole("combobox", { name: "Measurement year" })).toHaveValue("2025");
    unmount();

    navHolder.current.setUrl("/scorecard?year=next");
    serve(scorecard());
    render(<ScorecardPage />);
    await waitFor(() => expect(scorecardCalls().length).toBeGreaterThan(0));
    expect(scorecardCalls()[0]).toContain(`measurementYear=${new Date().getUTCFullYear()}`);
  });
});
