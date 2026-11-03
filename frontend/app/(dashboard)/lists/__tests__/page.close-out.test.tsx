/**
 * The attributed-list report from January (#882): the lead may re-score last year, so the report says which
 * run its numbers are from, and the year it opens on is the browser's own, not UTC's.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
const downloadBlob = vi.fn();
const apiMock = { getWithHeaders, get, post, downloadBlob };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("@/lib/toast", () => ({ emitToast: vi.fn() }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: "cm@workwell.dev" } }),
}));

import ListsPage from "../page";

const LIST = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "ACO attribution",
  revision: 1,
  source: null,
  note: null,
  createdBy: "cm@workwell.dev",
  createdAt: "2026-10-05T00:00:00.000Z",
  counts: { MATCHED: 10, NOT_FOUND: 0, AMBIGUOUS: 0 },
};

const measure = (measureId: string, runStartedAt: string | null) => ({
  measureId,
  ecqmId: null,
  runId: runStartedAt ? `run-${measureId}` : null,
  runStartedAt,
  measurementPeriod: runStartedAt ? { start: "2026-01-01", end: "2026-12-31" } : null,
  compactionStatus: runStartedAt ? "complete" : "no_run",
  matchedSubjects: 10,
  distinctSubjectsSeen: runStartedAt ? 10 : 0,
  missingFromRun: runStartedAt ? 0 : 10,
  rates: runStartedAt ? [{ label: null, ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 6, effectiveDenominator: 10, score: 0.6 }] : [],
});

function serveReport(measures: unknown[]) {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/subject-lists") return [LIST];
    if (path.includes("/report")) {
      const year = Number(/measurementYear=(\d{4})/.exec(path)?.[1]);
      return { measurementYear: year, generatedAt: "x", members: { matched: 10, notFound: 0, ambiguous: 0, total: 10 }, compactedMeasures: [], measures };
    }
    return [];
  });
}

async function computeReport() {
  render(<ListsPage />);
  await screen.findByText("ACO attribution");
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.click(await screen.findByRole("button", { name: "Compute" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setSubject("patient");
  getWithHeaders.mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
});

describe("the report names its run (#882)", () => {
  // Local dates around the year the page opens on, so the text is the same in any zone and any year.
  const year = new Date().getFullYear();
  const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  it("says the newest run any measure was read from, as the browser's own date", async () => {
    const june = new Date(year, 5, 2, 2).toISOString();
    const december = new Date(year, 11, 30, 2).toISOString();
    serveReport([measure("cms125", june), measure("cms122", december), measure("cms165", null)]);
    await computeReport();
    expect(await screen.findByTestId("list-report-source")).toHaveTextContent(`From WorkWell's run of ${longDate(december)}.`);
  });

  it("names a run that started the year after as the re-score of the report's year", async () => {
    const december = new Date(year, 11, 30, 2).toISOString();
    const reScore = new Date(year + 1, 0, 10, 9).toISOString();
    serveReport([measure("cms125", december), measure("cms122", reScore)]);
    await computeReport();
    expect(await screen.findByTestId("list-report-source")).toHaveTextContent(`From WorkWell's re-score of ${year} on ${longDate(reScore)}.`);
  });

  it("says nothing of a run where no measure had one", async () => {
    serveReport([measure("cms125", null)]);
    await computeReport();
    await screen.findByText("No completed population run for this year");
    expect(screen.queryByTestId("list-report-source")).toBeNull();
  });
});

/**
 * At 05:00 UTC on 1 January 2027 it is still the evening of 31 December in Hawaii: the report must open on
 * 2026, the year the practice is still in. The zone is set for this block only and put back after it.
 */
describe("the year the report opens on, in Hawaii on the evening of 31 December", () => {
  const before = process.env.TZ;
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  beforeAll(() => {
    process.env.TZ = "Pacific/Honolulu";
  });
  afterAll(() => {
    process.env.TZ = before ?? resolved;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is 2026 while UTC already says 2027", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-01T05:00:00Z"));
    // The premise, so the test cannot pass by the two calendars agreeing.
    expect(new Date().getUTCFullYear()).toBe(2027);
    expect(new Date().getFullYear()).toBe(2026);
    serveReport([]);
    await computeReport();
    expect(screen.getByRole("combobox", { name: "Measurement year" })).toHaveValue("2026");
    await waitFor(() => expect(get.mock.calls.map((c) => String(c[0])).some((p) => p.includes("/report?measurementYear=2026"))).toBe(true));
  });
});
