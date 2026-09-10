import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrdersPage from "../page";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { role: "ROLE_ADMIN", email: "admin@example.com" } }),
}));

const proposal = (n: number, measureId = "cms125") => ({
  subjectId: `subj-${n}`,
  measureId,
  order: { code: "77067", system: "http://www.ama-assn.org/go/cpt", display: "Screening mammography" },
  reasonOutcome: "OVERDUE",
  priority: "ROUTINE",
  status: "proposed",
  dedupeKey: `key-${n}`,
  authoredOn: "2026-09-10T00:00:00.000Z",
});

function proposalsQuery(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

function proposalCalls(): string[] {
  return get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/orders/proposals?"));
}

describe("OrdersPage paging + measure labels", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") {
        return Promise.resolve([
          { id: "cms125", name: "Breast Cancer Screening", status: "Active", identity: { cmsId: "CMS125", mipsQualityId: "112" } },
          { id: "cms122", name: "Diabetes: HbA1c Poor Control", status: "Deprecated", identity: { cmsId: "CMS122", mipsQualityId: "001" } },
        ]);
      }
      if (url.startsWith("/api/orders/proposals?")) {
        const offset = Number(proposalsQuery(url).get("offset") ?? 0);
        // Two rows per page; the totals say the whole set is far larger than any single page.
        return Promise.resolve({
          proposed: [proposal(offset + 1), proposal(offset + 2)],
          suppressed: [proposal(offset + 900, "cms122")],
          totals: { proposed: 234, suppressed: 5 },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  it("requests the first window, shows totals from `totals` (not array lengths), and pages via Next", async () => {
    render(<OrdersPage />);

    await waitFor(() => expect(screen.getByText("Proposed (234)")).toBeInTheDocument());
    expect(screen.getByText("Suppressed (5)")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();

    const first = proposalsQuery(proposalCalls()[0]);
    expect(first.get("format")).toBe("domain");
    expect(first.get("limit")).toBe("100");
    expect(first.get("offset")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByText("Page 2 of 3")).toBeInTheDocument());
    const second = proposalsQuery(proposalCalls().at(-1)!);
    expect(second.get("limit")).toBe("100");
    expect(second.get("offset")).toBe("100");
    await waitFor(() => expect(screen.getByText("subj-101")).toBeInTheDocument());
  });

  it("clamps the page when the totals shrink under it and refetches the last real page", async () => {
    // Totals are mutable so the set can shrink between pages, as a nightly run makes it.
    let totals = { proposed: 234, suppressed: 5 };
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.resolve([]);
      if (url.startsWith("/api/orders/proposals?")) {
        const offset = Number(proposalsQuery(url).get("offset") ?? 0);
        return Promise.resolve({ proposed: [proposal(offset + 1)], suppressed: [], totals });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Page 2 of 3")).toBeInTheDocument());

    // The set shrinks to one page while the user is on page 2, then they ask for page 3.
    totals = { proposed: 50, suppressed: 0 };
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // The page-3 response (offset 200) says one page: the page clamps to 1 and refetches offset 0.
    await waitFor(() => expect(proposalsQuery(proposalCalls().at(-1)!).get("offset")).toBe("0"));
    const calls = proposalCalls();
    expect(proposalsQuery(calls.at(-2)!).get("offset")).toBe("200");
    await waitFor(() => expect(screen.getByText("Page 1 of 1")).toBeInTheDocument());
    expect(screen.queryByText(/Page 3 of/)).not.toBeInTheDocument();
    expect(screen.getByText("subj-1")).toBeInTheDocument();
  });

  it("keeps Copy FHIR Bundle enabled on a page with no proposed rows when the total is non-zero", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.resolve([]);
      if (url.startsWith("/api/orders/proposals?")) {
        return Promise.resolve({ proposed: [], suppressed: [proposal(7)], totals: { proposed: 5, suppressed: 1 } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByText("Proposed (5)")).toBeInTheDocument());
    expect(screen.getByText("No proposed orders on this page.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy FHIR Bundle" })).not.toBeDisabled();
  });

  it("disables Copy FHIR Bundle only when the proposed TOTAL is zero", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/api/measures") return Promise.resolve([]);
      if (url.startsWith("/api/orders/proposals?")) {
        return Promise.resolve({ proposed: [], suppressed: [], totals: { proposed: 0, suppressed: 0 } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByText("Proposed (0)")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Copy FHIR Bundle" })).toBeDisabled();
  });

  it("drops a superseded response: a request in flight when the filter changes never lands", async () => {
    render(<OrdersPage />);
    await waitFor(() => expect(screen.getByText("subj-1")).toBeInTheDocument());

    // Hold the page-2 request open, then change the filter while it is still in flight.
    let resolveOld: (value: unknown) => void = () => {};
    get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(proposalsQuery(proposalCalls().at(-1)!).get("offset")).toBe("100"));

    await userEvent.click(screen.getByRole("combobox", { name: /measure/i }));
    await userEvent.click(screen.getByRole("option", { name: "Breast Cancer Screening" }));
    await waitFor(() => {
      const latest = proposalsQuery(proposalCalls().at(-1)!);
      expect(latest.get("measureId")).toBe("cms125");
      expect(latest.get("offset")).toBe("0");
    });
    await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());

    // The old request resolves late with rows that must never render.
    await act(async () => {
      resolveOld({ proposed: [proposal(999)], suppressed: [], totals: { proposed: 1, suppressed: 0 } });
    });
    expect(screen.queryByText("subj-999")).not.toBeInTheDocument();
    expect(screen.getByText("Proposed (234)")).toBeInTheDocument();
    expect(screen.getByText("subj-1")).toBeInTheDocument();
  });

  it("labels rows from the measure catalog (crosswalk identity) and never reads the programs overview", async () => {
    render(<OrdersPage />);

    await waitFor(() => expect(screen.getByText("subj-1")).toBeInTheDocument());
    expect(screen.getAllByText("MIPS 112 · CMS125 · Breast Cancer Screening").length).toBeGreaterThan(0);
    expect(get.mock.calls.some((c) => String(c[0]).startsWith("/api/programs/overview"))).toBe(false);
  });
});
