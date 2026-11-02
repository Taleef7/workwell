/**
 * The scorecard from January to March (#882). The year's first nightly closed every open case of the year
 * before; the lead may re-score that year so late records reach its scorecard, and this year's card rests on
 * the few patients seen so far. Every year here is the browser's own calendar's.
 *
 * The clock is faked for `Date` only, so the page's own timers and Testing Library's polling stay real. A
 * date built with the local constructor (`new Date(2027, 0, 15)`) is that local date in any zone the suite
 * runs in; the one test about the zone itself sets it.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { createNavMock } from "@/test/mocks/next-navigation-reactive";
import type { MyProvider } from "@/features/panel/use-my-provider";
import { ApiError } from "@/lib/api/errors";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const get = vi.fn();
const post = vi.fn();
const apiMock = { get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
const auth = vi.hoisted(() => ({ role: "ROLE_CASE_MANAGER", email: "quality-lead@maui.workwell.dev" }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: auth.role, email: auth.email } }) }));
const runState = vi.hoisted(() => ({ isActive: false, activeRunId: null as string | null }));
const startTracking = vi.fn();
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: runState.isActive, activeRunId: runState.activeRunId, startTracking }),
}));
const emitToast = vi.fn();
vi.mock("@/lib/toast", () => ({ emitToast: (...args: unknown[]) => emitToast(...args) }));
const myProvider = vi.hoisted(() => ({ provider: null as MyProvider | null, loaded: true, error: false, retry: () => {} }));
vi.mock("@/features/panel/use-my-provider", () => ({ useMyProvider: () => myProvider }));

const navHolder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createNavMock> }));
vi.mock("next/navigation", async () => {
  const { createNavMock } = await import("@/test/mocks/next-navigation-reactive");
  navHolder.current = createNavMock("/scorecard");
  return navHolder.current.navigation;
});

import ScorecardPage from "../page";

const SILVA: MyProvider = { id: "maui-prov-011", name: "Dr. Ana Silva", location: "Wailuku Clinic" };
const JANUARY = new Date(2027, 0, 15, 10);
/** The browser's own long date, as the page writes it. */
const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
/** A run that started on 30 December 2026, the year's own last nightly, in the browser's zone. */
const DECEMBER_RUN = new Date(2026, 11, 30, 2).toISOString();
/** The January re-score of 2026. */
const JANUARY_RUN = new Date(2027, 0, 10, 9).toISOString();

const rate = (numer: number, effectiveDenominator: number) => ({
  label: null,
  ipp: effectiveDenominator,
  numer,
  effectiveDenominator,
  score: effectiveDenominator > 0 ? numer / effectiveDenominator : null,
  smallNumber: effectiveDenominator < 20,
});
const cell = (numer: number, denominator: number) => ({ rates: [rate(numer, denominator)], openGaps: 0 });

function card(measurementYear: number, runStartedAt: string, over: Record<string, unknown> = {}) {
  return {
    measurementYear,
    generatedAt: runStartedAt,
    smallNumberThreshold: 20,
    openGapsShown: true,
    panel: { requested: "all", ownsPanel: false },
    measures: [
      { measureId: "cms125", name: "Breast Cancer Screening", state: "complete", runStartedAt, executedLogic: null, logic: null, numeratorMeansCompliant: true },
    ],
    locations: [
      {
        location: "Wailuku Clinic",
        providers: [{ providerId: "p-a", name: "Dr. A", cells: { cms125: cell(3, 4) } }],
        subtotal: { providerId: null, name: "Wailuku Clinic", cells: { cms125: cell(3, 4) } },
      },
    ],
    other: null,
    total: { providerId: null, name: "Total", cells: { cms125: cell(3, 4) } },
    ...over,
  };
}

/** A linked clinician's card: their row and the practice total, no locations. */
function clinicianCard(measurementYear: number, runStartedAt: string) {
  return card(measurementYear, runStartedAt, {
    locations: [],
    scope: { providerId: SILVA.id, name: SILVA.name, location: SILVA.location, row: { providerId: SILVA.id, name: SILVA.name, cells: { cms125: cell(1, 2) } } },
  });
}

/** Serves each year its own card, so a switch of year shows in what is drawn as well as in what is asked. */
function serve(cards: Record<number, unknown>) {
  get.mockReset().mockImplementation((url: string) => {
    if (url.startsWith("/api/scorecard")) {
      const year = Number(/measurementYear=(\d{4})/.exec(url)?.[1]);
      return Promise.resolve(cards[year] ?? card(year, DECEMBER_RUN));
    }
    return Promise.resolve([]);
  });
}

const scorecardCalls = (): string[] => get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/scorecard"));
const at = (date: Date) => vi.setSystemTime(date);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(JANUARY);
  setSubject("patient");
  auth.role = "ROLE_CASE_MANAGER";
  runState.isActive = false;
  runState.activeRunId = null;
  myProvider.provider = SILVA;
  startTracking.mockReset();
  emitToast.mockReset();
  post.mockReset().mockResolvedValue({ runId: "run-rescore", status: "RUNNING" });
  try {
    localStorage.clear();
  } catch {
    /* jsdom always has it */
  }
  navHolder.current.setUrl("/scorecard?panel=all&year=2026");
  navHolder.current.replace.mockClear();
  serve({ 2026: card(2026, DECEMBER_RUN), 2027: card(2027, JANUARY_RUN) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Closing out last year (#882)", () => {
  it.each([
    ["ROLE_CASE_MANAGER", new Date(2027, 0, 2, 8)],
    ["ROLE_ADMIN", new Date(2027, 1, 20, 14)],
    ["ROLE_CASE_MANAGER", new Date(2027, 2, 31, 23)],
  ])("offers %s a re-score of last year on its card (%s)", async (role, when) => {
    auth.role = role;
    at(when);
    render(<ScorecardPage />);
    const panel = await screen.findByTestId("scorecard-close-out");
    expect(within(panel).getByRole("heading", { name: "Closing out 2026" })).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      `2026's figures are from the run of ${longDate(DECEMBER_RUN)}. Re-score 2026 to count records of 2026 care that arrived since. No 2026 case is reopened, and the work list stays on 2027.`,
    );
    expect(within(panel).getByRole("button", { name: "Re-score 2026" })).toBeEnabled();
  });

  it.each(["ROLE_QUALITY_STAFF", "ROLE_VIEWER"])("offers %s no re-score: the staff seat and a clinician start no run", async (role) => {
    auth.role = role;
    serve({ 2026: card(2026, DECEMBER_RUN), 2027: card(2027, JANUARY_RUN) });
    if (role === "ROLE_VIEWER") serve({ 2026: clinicianCard(2026, DECEMBER_RUN) });
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    await waitFor(() => expect(scorecardCalls().at(-1)).toContain("measurementYear=2026"));
    expect(screen.queryByTestId("scorecard-close-out")).toBeNull();
    expect(screen.queryByRole("button", { name: /Re-scor/ })).toBeNull();
  });

  it("offers nothing on this year's card", async () => {
    navHolder.current.setUrl("/scorecard?panel=all&year=2027");
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    expect(scorecardCalls().at(-1)).toContain("measurementYear=2027");
    expect(screen.queryByTestId("scorecard-close-out")).toBeNull();
  });

  it("offers nothing from April", async () => {
    at(new Date(2027, 3, 1, 9));
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    expect(scorecardCalls().at(-1)).toContain("measurementYear=2026");
    expect(screen.queryByTestId("scorecard-close-out")).toBeNull();
  });

  it("asks first, and Cancel starts nothing", async () => {
    render(<ScorecardPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-score 2026" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Re-score 2026?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "This scores every measure for every patient over 2026. It takes about as long as the nightly update; you can leave this page.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("confirmed, starts the re-score of exactly last year, tracks it and says so", async () => {
    render(<ScorecardPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-score 2026" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-score 2026" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/runs/manual", { scopeType: "ALL_PROGRAMS", evaluationDate: "2026-12-31" });
    await waitFor(() => expect(startTracking).toHaveBeenCalledWith("run-rescore", "RUNNING"));
    expect(emitToast).toHaveBeenCalledWith("Re-scoring 2026. The scorecard updates when it finishes.");
  });

  it("says the server's sentence when another run is already in flight", async () => {
    post.mockReset().mockRejectedValue(
      new ApiError(409, JSON.stringify({ error: "run_in_progress", runId: "run-nightly", message: "x" }), "Request failed (409)"),
    );
    render(<ScorecardPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-score 2026" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-score 2026" }));
    expect(await within(screen.getByTestId("scorecard-close-out")).findByRole("alert")).toHaveTextContent(
      "A run is already in progress; try again when it finishes.",
    );
    expect(startTracking).not.toHaveBeenCalled();
  });

  it("while its re-score runs, the button says so and cannot start another", async () => {
    localStorage.setItem("ww_rescore_run", "run-rescore");
    runState.isActive = true;
    runState.activeRunId = "run-rescore";
    render(<ScorecardPage />);
    const button = await screen.findByRole("button", { name: "Re-scoring 2026…" });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Re-score 2026" })).toBeNull();
  });

  it("while another run is in flight, the server decides: an import a client left running holds nothing", async () => {
    localStorage.setItem("ww_rescore_run", "run-rescore");
    runState.isActive = true;
    runState.activeRunId = "run-import";
    render(<ScorecardPage />);
    const button = await screen.findByRole("button", { name: "Re-score 2026" });
    expect(button).toBeEnabled();
    expect(within(screen.getByTestId("scorecard-close-out")).queryByRole("status")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-score 2026" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runs/manual", { scopeType: "ALL_PROGRAMS", evaluationDate: "2026-12-31" }));
  });

  it("reads the card again when a run finishes", async () => {
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-close-out");
    const before = scorecardCalls().length;
    act(() => {
      window.dispatchEvent(new CustomEvent("ww:run-complete", { detail: { runId: "run-rescore", status: "COMPLETED" } }));
    });
    await waitFor(() => expect(scorecardCalls().length).toBe(before + 1));
    expect(scorecardCalls().at(-1)).toContain("measurementYear=2026");
  });
});

describe("the note names a re-score as one", () => {
  it("a run that started after the card's year ended is the year's re-score", async () => {
    serve({ 2026: card(2026, JANUARY_RUN) });
    render(<ScorecardPage />);
    const note = await screen.findByTestId("scorecard-note");
    await waitFor(() => expect(note).toHaveTextContent(`From WorkWell's re-score of 2026 on ${longDate(JANUARY_RUN)}.`));
    expect(note).not.toHaveTextContent("From WorkWell's run of");
    // The panel names the run its figures are from, the re-score itself.
    expect(screen.getByTestId("scorecard-close-out")).toHaveTextContent(`2026's figures are from the run of ${longDate(JANUARY_RUN)}.`);
  });

  it("a run within the card's year is a run", async () => {
    render(<ScorecardPage />);
    const note = await screen.findByTestId("scorecard-note");
    await waitFor(() => expect(note).toHaveTextContent(`From WorkWell's run of ${longDate(DECEMBER_RUN)}.`));
    expect(note).not.toHaveTextContent("re-score");
  });
});

describe("this year's card from January to March", () => {
  const NEW_YEAR =
    "2027 has just begun: a patient counts once they have a 2027 visit, so these rates rest on few patients.";

  it("says the practice's rates rest on few patients, and See 2026 switches the year", async () => {
    navHolder.current.setUrl("/scorecard?panel=all&year=2027");
    render(<ScorecardPage />);
    const line = await screen.findByTestId("scorecard-new-year");
    expect(line).toHaveTextContent(NEW_YEAR);
    fireEvent.click(within(line).getByRole("button", { name: "See 2026 →" }));
    expect(navHolder.current.params.get("year")).toBe("2026");
    expect(navHolder.current.params.get("panel")).toBe("all");
    await waitFor(() => expect(scorecardCalls().at(-1)).toContain("measurementYear=2026"));
    // The line belongs to this year's card; last year's has the close-out instead.
    await screen.findByTestId("scorecard-close-out");
    expect(screen.queryByTestId("scorecard-new-year")).toBeNull();
  });

  it("says so on a clinician's own scorecard too, and See 2026 switches the year there", async () => {
    auth.role = "ROLE_VIEWER";
    navHolder.current.setUrl("/scorecard");
    serve({ 2026: clinicianCard(2026, DECEMBER_RUN), 2027: clinicianCard(2027, JANUARY_RUN) });
    render(<ScorecardPage />);
    const line = await screen.findByTestId("scorecard-new-year");
    expect(line).toHaveTextContent(NEW_YEAR);
    fireEvent.click(within(line).getByRole("button", { name: "See 2026 →" }));
    expect(navHolder.current.replace).toHaveBeenLastCalledWith("/scorecard?year=2026", { scroll: false });
    await waitFor(() => expect(scorecardCalls().at(-1)).toBe("/api/scorecard?measurementYear=2026"));
    await waitFor(() => expect(screen.queryByTestId("scorecard-new-year")).toBeNull());
  });

  it.each([
    ["the practice", "ROLE_QUALITY_STAFF", "/scorecard?panel=all"],
    ["a clinician", "ROLE_VIEWER", "/scorecard"],
  ])("says nothing of it from April, on %s's scorecard", async (_who, role, url) => {
    at(new Date(2027, 3, 2, 9));
    auth.role = role;
    navHolder.current.setUrl(url);
    serve({ 2027: role === "ROLE_VIEWER" ? clinicianCard(2027, JANUARY_RUN) : card(2027, JANUARY_RUN) });
    render(<ScorecardPage />);
    await screen.findByTestId("scorecard-table");
    expect(scorecardCalls().at(-1)).toContain("measurementYear=2027");
    expect(screen.queryByTestId("scorecard-new-year")).toBeNull();
  });
});

/**
 * The default year is the browser's, not UTC's. At 05:00 UTC on 1 January 2027 it is still the evening of
 * 31 December in Hawaii, where the practice is: the page must ask for 2026, as the server's own "today" says.
 * The zone is set for this block only and put back after it.
 */
describe("the default year in Hawaii on the evening of 31 December", () => {
  const before = process.env.TZ;
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  beforeAll(() => {
    process.env.TZ = "Pacific/Honolulu";
  });
  afterAll(() => {
    process.env.TZ = before ?? resolved;
  });

  it("is 2026 while UTC already says 2027", async () => {
    at(new Date("2027-01-01T05:00:00Z"));
    // The premise, so the test cannot pass by the two calendars agreeing.
    expect(new Date().getUTCFullYear()).toBe(2027);
    expect(new Date().getFullYear()).toBe(2026);
    navHolder.current.setUrl("/scorecard?panel=all");
    render(<ScorecardPage />);
    await waitFor(() => expect(scorecardCalls().length).toBeGreaterThan(0));
    expect(scorecardCalls()[0]).toContain("measurementYear=2026");
    expect(screen.getByRole("combobox", { name: "Measurement year" })).toHaveValue("2026");
  });

  it("prints the month the card was made in, by the practice's calendar", async () => {
    at(new Date("2027-01-01T05:00:00Z"));
    serve({ 2026: card(2026, "2027-01-01T05:00:00.000Z") });
    render(<ScorecardPage />);
    const december = new Date(2026, 11, 15).toLocaleDateString(undefined, { year: "numeric", month: "long" });
    expect(await screen.findByText(/^Quality scorecard — /)).toHaveTextContent(`Quality scorecard — ${december}`);
  });
});
