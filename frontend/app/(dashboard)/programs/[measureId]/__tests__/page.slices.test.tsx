/**
 * The measure page paints as each read lands, and says when a panel failed.
 *
 * Before this the four reads were gated behind `Promise.allSettled`, so the page showed nothing until
 * the slowest one answered. On the pilot `risk-outlook` answered 504 after 60 s, which is why the Maui
 * e2e suite's one flake is this page rendering no heading within 20 s.
 *
 * The deferred promises here are the point: a never-resolving `risk-outlook` is exactly the pilot's
 * condition, and the heading and KPI must still be on screen.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSubject, subject } from "@/test/mocks/terminology";
vi.mock("@/lib/terminology", () => ({ SUBJECT: subject }));
import ProgramDetailPage from "../page";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

let currentMeasureId = "cms125";
vi.mock("next/navigation", () => ({
  useParams: () => ({ measureId: currentMeasureId }),
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN" } }),
}));
vi.mock("@/components/run-status-provider", () => ({
  useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }),
}));

const programFor = (measureId: string, measureName: string) => ({
  measureId,
  measureName,
  policyRef: measureId.toUpperCase(),
  version: "v1.0",
  latestRunId: "run-1",
  latestRunAt: "2026-08-30T00:00:00Z",
  totalEvaluated: 10,
  denominator: 10,
  compliant: 5,
  dueSoon: 2,
  overdue: 2,
  missingData: 1,
  excluded: 0,
  complianceRate: 50,
  openCaseCount: 4,
});

const PROGRAMS = [programFor("cms125", "Breast Cancer Screening"), programFor("cms122", "Diabetes")];

/** A promise plus the handles to settle it later. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const EMPTY_DRIVERS = { bySite: [], byRole: [], byOutcomeReason: [] };

beforeEach(() => {
  setSubject("employee");
  currentMeasureId = "cms125";
  get.mockReset();
});

describe("ProgramDetailPage — per-slice paint", () => {
  it("renders the heading and KPI while risk-outlook never answers", async () => {
    const stuck = deferred<unknown>();
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve(PROGRAMS);
      if (url.includes("/risk-outlook")) return stuck.promise;
      if (url.includes("/trend")) return Promise.resolve([]);
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    // The whole point: a read that never answers does not hold the page.
    expect(await screen.findByRole("heading", { name: /Breast Cancer Screening/ })).toBeInTheDocument();
    expect(screen.getByText(/Compliance 50\.0%/)).toBeInTheDocument();
    // And the panel that is still waiting says so rather than showing a zero. Scoped strings, not
    // a shared "Loading…" that `getByText` throws on as soon as a second panel is also waiting.
    expect(screen.getByText("Loading risk outlook…")).toBeInTheDocument();
    // The trend read HAS resolved here (to []), so the chart may state the measure has no
    // history. That claim is only false while the read is in flight — asserted below.
    expect(screen.queryByText("Loading trend…")).toBeNull();
  });

  it("never claims a measure has NO run history while the trend read is in flight", async () => {
    // The P1 the mutations and both external lanes missed. `ComplianceTrendChart` answers an empty
    // `points` array with "No runs with results yet" — a positive claim about the
    // measure. While the page gated its first paint on all four reads that was unreachable; with
    // per-panel paint, /api/programs (memoized) answers before /trend, so the largest panel on the
    // page asserted a measure had no history while its history was loading.
    const stuckTrend = deferred<unknown[]>();
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve(PROGRAMS);
      if (url.includes("/trend")) return stuckTrend.promise;
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByRole("heading", { name: /Breast Cancer Screening/ })).toBeInTheDocument();
    expect(screen.getByText("Loading trend…")).toBeInTheDocument();
    expect(screen.queryByText("No runs with results yet")).toBeNull();

    // Once it answers empty, the claim is legitimate.
    stuckTrend.resolve([]);
    await waitFor(() => expect(screen.getByText("No runs with results yet")).toBeInTheDocument());
  });

  it("says the trend is UNAVAILABLE when it fails, rather than that there is no history", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve(PROGRAMS);
      if (url.includes("/trend")) return Promise.reject(new Error("504"));
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("Trend unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No runs with results yet")).toBeNull();
  });

  it("shows 'Risk outlook unavailable' when the read REJECTS, not a zero", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve(PROGRAMS);
      if (url.includes("/risk-outlook")) return Promise.reject(new Error("504 Gateway Timeout"));
      if (url.includes("/trend")) return Promise.resolve([]);
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("Risk outlook unavailable")).toBeInTheDocument();
    // A 504 used to render as three zeroes and a dash, which reads as "nothing is coming due".
    expect(screen.queryByText("Upcoming due soon")).toBeNull();
    // The page itself is fine — only that panel is not.
    expect(screen.getByRole("heading", { name: /Breast Cancer Screening/ })).toBeInTheDocument();
  });

  it("a rejected panel does not blank the page or raise the page-level error banner", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve(PROGRAMS);
      if (url.includes("/trend")) return Promise.reject(new Error("boom"));
      if (url.includes("/top-drivers")) return Promise.reject(new Error("boom"));
      if (url.includes("/risk-outlook")) return Promise.reject(new Error("boom"));
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByRole("heading", { name: /Breast Cancer Screening/ })).toBeInTheDocument();
    expect(screen.getByText("Run history unavailable")).toBeInTheDocument();
    expect(screen.getByText("Risk outlook unavailable")).toBeInTheDocument();
    // The banner belongs to the `programs` read alone — the page still has a heading and a KPI.
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("surfaces the page-level banner when the PROGRAMS read fails", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.reject(new Error("programs exploded"));
      if (url.includes("/trend")) return Promise.resolve([]);
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("programs exploded")).toBeInTheDocument();
  });

  it("an unknown measure says so instead of spinning a skeleton forever", async () => {
    // Found by an external lane. `/api/programs` ANSWERS and the measure simply is not in it, so
    // `program` stays null with `status.program === "ready"` — and the old fallback, gated only on
    // `program` being truthy, announced "Loading measure detail…" to a screen reader forever.
    currentMeasureId = "cms999";
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve(PROGRAMS);
      if (url.includes("/trend")) return Promise.resolve([]);
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("No active measure with this id.")).toBeInTheDocument();
    expect(screen.queryByText("Loading measure detail…")).toBeNull();
  });

  it("a failed programs read shows the banner and stops the skeleton, not both forever", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.reject(new Error("programs exploded"));
      if (url.includes("/trend")) return Promise.resolve([]);
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      if (url.includes("/risk-outlook")) return Promise.resolve(null);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("programs exploded")).toBeInTheDocument();
    expect(await screen.findByText("This measure could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Loading measure detail…")).toBeNull();
  });

  it("a late response for the PREVIOUS measure never lands under the new one", async () => {
    // A → B with A's outlook read still in flight, and the component stays MOUNTED across the change
    // (`rerender`, not unmount-and-render) — otherwise A's late resolution has no live component to
    // land in and the test passes whatever the reducer does. Verified by mutation: removing the tag
    // check fails this.
    //
    // `useParams` is a synchronous mock, so this is not the router half of the race — the harness
    // cannot produce that (JOURNAL 2026-09-12). It is the response-ordering half, which is what the
    // tag protects. The tag rule itself is unit-tested in measure-slices.test.ts.
    const slowOutlookA = deferred<unknown>();
    const outlookA = {
      upcomingNonCompliantCount: 999,
      upcomingExpirations: [],
      repeatNonCompliers: [],
      siteComplianceRates: [{ site: "A-only site", total: 1, compliant: 1, upcomingExpirations: 0, currentComplianceRate: 100, predictedComplianceRate: 100 }],
    };
    const outlookB = {
      upcomingNonCompliantCount: 42,
      upcomingExpirations: [],
      repeatNonCompliers: [],
      siteComplianceRates: [{ site: "B site", total: 1, compliant: 1, upcomingExpirations: 0, currentComplianceRate: 100, predictedComplianceRate: 100 }],
    };
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve(PROGRAMS);
      if (url.includes("/risk-outlook")) {
        return currentMeasureId === "cms125" ? slowOutlookA.promise : Promise.resolve(outlookB);
      }
      if (url.includes("/trend")) return Promise.resolve([]);
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      return Promise.resolve([]);
    });

    const { rerender } = render(<ProgramDetailPage />);
    expect(await screen.findByRole("heading", { name: /Breast Cancer Screening/ })).toBeInTheDocument();

    currentMeasureId = "cms122";
    rerender(<ProgramDetailPage />);
    expect(await screen.findByRole("heading", { name: /Diabetes/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());

    // A's outlook arrives now, into the same live component. It must be dropped.
    slowOutlookA.resolve(outlookA);
    await waitFor(() => expect(screen.getByRole("heading", { name: /Diabetes/ })).toBeInTheDocument());
    expect(screen.queryByText("999")).toBeNull();
    expect(screen.queryByText("A-only site")).toBeNull();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("a ww:run-complete refresh keeps the current values on screen while the new ones load", async () => {
    const firstOutlook = {
      upcomingNonCompliantCount: 7,
      upcomingExpirations: [],
      repeatNonCompliers: [],
      siteComplianceRates: [{ site: "Plant A", total: 10, compliant: 5, upcomingExpirations: 1, currentComplianceRate: 50, predictedComplianceRate: 40 }],
    };
    let outlookCalls = 0;
    const secondOutlook = deferred<unknown>();
    get.mockImplementation((url: string) => {
      if (url === "/api/programs" || url.startsWith("/api/programs?")) return Promise.resolve(PROGRAMS);
      if (url.includes("/risk-outlook")) {
        outlookCalls += 1;
        return outlookCalls === 1 ? Promise.resolve(firstOutlook) : secondOutlook.promise;
      }
      if (url.includes("/trend")) return Promise.resolve([]);
      if (url.includes("/top-drivers")) return Promise.resolve(EMPTY_DRIVERS);
      return Promise.resolve([]);
    });

    render(<ProgramDetailPage />);
    expect(await screen.findByText("7")).toBeInTheDocument();

    window.dispatchEvent(new Event("ww:run-complete"));
    await waitFor(() => expect(outlookCalls).toBe(2));
    // The refresh did NOT reset the panel to its skeleton: 7 is still there while the new read runs.
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.queryByText("Risk outlook unavailable")).toBeNull();
  });
});
