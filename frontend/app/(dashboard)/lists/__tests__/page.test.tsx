/**
 * The attributed-lists page (MM-2 PR 3, ADR-082).
 *
 * What is worth pinning here is the behaviour a screenshot would not show: a list whose rows arrive
 * in the wrong shape must cost the picker and not the page; the server's refusal is rendered VERBATIM
 * rather than paraphrased (the sandbox gate's message carries the only number the operator needs);
 * and the report cannot be asked for without a measurement year.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
const downloadBlob = vi.fn();
const apiMock = { getWithHeaders, get, post, downloadBlob };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const emitToast = vi.fn();
vi.mock("@/lib/toast", () => ({ emitToast: (...args: unknown[]) => emitToast(...args) }));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_CASE_MANAGER", email: "cm@workwell.dev" } }),
}));

import ListsPage from "../page";

const LIST = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "ACO Q3 attribution",
  revision: 2,
  source: "the quarterly file",
  note: null,
  createdBy: "cm@workwell.dev",
  createdAt: "2027-01-05T00:00:00.000Z",
  counts: { MATCHED: 1382, NOT_FOUND: 7, AMBIGUOUS: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (path: string) => {
    if (path === "/api/subject-lists") return [LIST];
    throw new Error(`unexpected GET ${path}`);
  });
  getWithHeaders.mockResolvedValue({ data: [], headers: new Headers({ "X-Total-Count": "0" }) });
});

it("lists each import with its counts, and the not-found count is shown rather than buried", async () => {
  render(<ListsPage />);
  await screen.findByText("ACO Q3 attribution");
  // Grouped by the browser's locale — the page renders 1,382, so a test asserting /1382/ would fail
  // for the right reason and a test asserting /\d+/ would read it as 382.
  expect(screen.getByText("1,382")).toBeInTheDocument();
  // The unresolved members are the finding somebody has to work, not a footnote.
  expect(screen.getByText("7")).toBeInTheDocument();
  expect(screen.getByText("v2")).toBeInTheDocument();
});

it("rows in an unrecognised shape cost the PICKER, not the page", async () => {
  // The defect this hook family exists for: a successful fetch carrying the wrong payload used to take
  // the whole page down on `.toLocaleString()`. An empty table is a survivable answer; a blank screen
  // is not — and a wholly unusable payload is a server bug, so it warns rather than reading as "no
  // lists on this deployment".
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  get.mockResolvedValue([{ id: "x", name: "broken" }]);
  render(<ListsPage />);
  await screen.findByText("No attributed lists yet.");
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it("the server's refusal is shown VERBATIM — the sandbox gate's count is the point of it", async () => {
  // "Import refused" alone would drop the one number the operator needs: how many identifiers were
  // outside the namespace. The message is the server's, not a paraphrase.
  post.mockRejectedValue(
    new Error(
      "this deployment is a synthetic sandbox; every identifier must belong to its generated directory's namespace, and nothing was written",
    ),
  );
  render(<ListsPage />);
  await screen.findByText("ACO Q3 attribution");
  await userEvent.type(screen.getByPlaceholderText(/^Name/), "real file");
  await userEvent.type(screen.getByPlaceholderText(/One identifier per line/), "MRN-40182");
  await userEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(emitToast).toHaveBeenCalled());
  expect(String(emitToast.mock.calls[0]![0])).toMatch(/nothing was written/);
  expect(emitToast.mock.calls[0]![1]).toBe("error");
});

it("the report is never requested without a measurement year", async () => {
  // ADR-072: an officially routed run is scored over its calendar year, so "the latest numbers" would
  // answer a PY2027 question with PY2028's first nightly the moment January arrives. The select is the
  // only way in, and every request it makes names a year.
  get.mockImplementation(async (path: string) => {
    if (path === "/api/subject-lists") return [LIST];
    if (path.startsWith(`/api/subject-lists/${LIST.id}/report`)) {
      return { measurementYear: 2027, generatedAt: "x", members: { matched: 1, notFound: 0, ambiguous: 0, total: 1 }, compactedMeasures: [], measures: [] };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  render(<ListsPage />);
  await screen.findByText("ACO Q3 attribution");
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.click(await screen.findByRole("button", { name: "Compute" }));
  await waitFor(() => {
    const reportCalls = get.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/report"));
    expect(reportCalls.length).toBeGreaterThan(0);
    for (const path of reportCalls) expect(path).toMatch(/measurementYear=\d{4}/);
  });
});

it("changing the year clears the report, so the table and the Download button cannot disagree", async () => {
  // `download` reads the CURRENT year. Leaving the computed table up after a year change put two
  // different years on one screen, neither labelled — an operator could read 2026 and download 2027.
  get.mockImplementation(async (path: string) => {
    if (path === "/api/subject-lists") return [LIST];
    if (path.includes("/report")) {
      return {
        measurementYear: 2027, generatedAt: "x",
        members: { matched: 1, notFound: 0, ambiguous: 0, total: 1 },
        compactedMeasures: [],
        measures: [{
          measureId: "cms125", ecqmId: "CMS125", runId: "run-1",
          measurementPeriod: { start: "2027-01-01", end: "2027-12-31" },
          compactionStatus: "complete", matchedSubjects: 1, distinctSubjectsSeen: 1, missingFromRun: 0,
          rates: [{ label: null, ipp: 1, denom: 1, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 1, score: 1 }],
        }],
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  render(<ListsPage />);
  await screen.findByText("ACO Q3 attribution");
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.click(await screen.findByRole("button", { name: "Compute" }));
  await screen.findByText("100.0%");
  expect(screen.getByRole("button", { name: /Download/ })).toBeInTheDocument();

  const yearSelect = screen.getByLabelText(/Measurement year/i);
  await userEvent.selectOptions(yearSelect, String(new Date().getUTCFullYear() - 1));
  await waitFor(() => expect(screen.queryByText("100.0%")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
});

it("the year select offers the NEXT year — the pilot's target is PY2027 while the clock says 2026", async () => {
  // A list of past years alone would make the one year the pilot exists for unreachable from this
  // page until the clock caught up, even though a run can already be created with that evaluation date.
  render(<ListsPage />);
  await screen.findByText("ACO Q3 attribution");
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  const yearSelect = await screen.findByLabelText(/Measurement year/i);
  const offered = Array.from(yearSelect.querySelectorAll("option")).map((o) => o.textContent);
  expect(offered).toContain(String(new Date().getUTCFullYear() + 1));
  expect(offered).toContain(String(new Date().getUTCFullYear()));
});

it("a measure whose run aged out is named, with the reason, beside the ones that reported", async () => {
  // ADR-077's refusal belongs to the measure whose evidence may be incomplete. Withholding the other
  // five would be a second wrong answer, and showing this one's numbers would be the first.
  get.mockImplementation(async (path: string) => {
    if (path === "/api/subject-lists") return [LIST];
    if (path.includes("/report")) {
      return {
        measurementYear: 2027,
        generatedAt: "2027-06-01T00:00:00.000Z",
        members: { matched: 2, notFound: 0, ambiguous: 0, total: 2 },
        compactedMeasures: ["cms122"],
        measures: [
          { measureId: "cms122", ecqmId: null, runId: null, measurementPeriod: null, compactionStatus: "compacted", matchedSubjects: 2, distinctSubjectsSeen: 0, missingFromRun: 0, rates: [] },
          {
            measureId: "cms125", ecqmId: "CMS125", runId: "run-1",
            measurementPeriod: { start: "2027-01-01", end: "2027-12-31" },
            compactionStatus: "complete", matchedSubjects: 2, distinctSubjectsSeen: 2, missingFromRun: 1,
            rates: [{ label: null, ipp: 2, denom: 2, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 2, score: 0.5 }],
          },
        ],
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  render(<ListsPage />);
  await screen.findByText("ACO Q3 attribution");
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.click(await screen.findByRole("button", { name: "Compute" }));
  await screen.findByText(/cannot be reported for 2027/);
  expect(screen.getByText("Refused — the run predates a retention cutoff")).toBeInTheDocument();
  // The complete measure still shows its numbers, and its unmeasured members beside them.
  expect(screen.getByText("50.0%")).toBeInTheDocument();
});
