import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseOrdersPanel, CaseOrdersView } from "../CaseOrdersPanel";
import { OrderCodesAdmin } from "../OrderCodesAdmin";

const get = vi.fn();
const post = vi.fn();
// One client across renders, as the real `useApi` memoizes it: a new object per render would re-run every
// effect and hide a missing dependency.
const api = { get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => api }));
vi.mock("@/lib/toast", () => ({ emitToast: vi.fn() }));

const CPT = "http://www.ama-assn.org/go/cpt";

describe("CaseOrdersView (#620, B16)", () => {
  it("lists a choice's options, card state and catalog notes, with no default", () => {
    render(
      <CaseOrdersView
        data={{
          caseId: "c1",
          measureId: "cms130",
          applies: true,
          orders: {
            mode: "choice",
            options: [
              { key: `${CPT}|82274`, code: "82274", system: CPT, display: "FIT", interval: "every year", suggestible: true, approved: true },
              { key: `${CPT}|45378`, code: "45378", system: CPT, display: "Colonoscopy", note: "Medicare bills G0121", suggestible: true, approved: false },
            ],
          },
        }}
      />,
    );
    const panel = screen.getByTestId("case-orders");
    expect(within(panel).getByText(/clinician chooses one/)).toBeInTheDocument();
    expect(within(panel).getByText("Card-ready")).toBeInTheDocument();
    expect(within(panel).getByText("Awaiting admin approval")).toBeInTheDocument();
    expect(within(panel).getByText(/Catalog note: every year/)).toBeInTheDocument();
    expect(within(panel).getByText(/WorkWell orders nothing/)).toBeInTheDocument();
  });

  it("says why no order applies, and lists none", () => {
    render(
      <CaseOrdersView
        data={{
          caseId: "c1",
          measureId: "cms165",
          applies: false,
          reason: "A blood pressure reading was found, and CQL counts it as not controlled. See the next action.",
          orders: { mode: "choice", options: [{ key: `${CPT}|99473`, code: "99473", system: CPT, display: "Home BP", suggestible: true, approved: true }] },
        }}
      />,
    );
    expect(screen.getByTestId("case-orders-why-not")).toHaveTextContent(/not controlled/);
    expect(screen.queryByText("Home BP")).toBeNull();
  });

  it("renders nothing for a measure with no order defined", () => {
    const { container } = render(<CaseOrdersView data={{ caseId: "c1", measureId: "x", applies: false, reason: "No order", orders: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CaseOrdersPanel refresh", () => {
  beforeEach(() => get.mockReset());

  it("asks again when the case changes, so a rerun or resolve never leaves stale options", async () => {
    const opts = { mode: "choice", options: [{ key: `${CPT}|82274`, code: "82274", system: CPT, display: "FIT", suggestible: true, approved: true }] };
    get.mockResolvedValueOnce({ caseId: "c1", measureId: "cms130", applies: true, orders: opts });
    const { rerender } = render(<CaseOrdersPanel caseId="c1" revision="t1|OPEN|r1" />);
    expect(await screen.findByText("FIT")).toBeInTheDocument();

    // Same revision: no new read.
    rerender(<CaseOrdersPanel caseId="c1" revision="t1|OPEN|r1" />);
    expect(get).toHaveBeenCalledTimes(1);

    get.mockResolvedValueOnce({ caseId: "c1", measureId: "cms130", applies: false, reason: "This case is closed.", orders: opts });
    rerender(<CaseOrdersPanel caseId="c1" revision="t2|RESOLVED|r2" />);
    expect(await screen.findByTestId("case-orders-why-not")).toHaveTextContent("This case is closed.");
    expect(screen.queryByText("FIT")).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("OrderCodesAdmin (#640, owner decision 2026-11-04)", () => {
  const row = (code: string, status: string, suggestible = true) => ({
    measureId: "cms130", mode: "choice", key: `${CPT}|${code}`, system: CPT, code, display: `Option ${code}`,
    interval: null, audience: null, note: null, suggestible, status, reviewedBy: null, reviewedAt: null, mappings: [],
  });

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ codes: [row("82274", "PROPOSED"), row("45378", "APPROVED"), { ...row("bp", "PROPOSED", false), system: "urn:workwell:orders" }] });
    post.mockResolvedValue({ reviewed: [] });
  });

  it("approves a PROPOSED code with the admin's note, through a confirm step", async () => {
    render(<OrderCodesAdmin />);
    const fit = await screen.findByTestId("order-code-82274");
    fireEvent.click(within(fit).getByRole("button", { name: "Approve" }));
    fireEvent.change(await screen.findByLabelText("Note (optional)"), { target: { value: "owner sign-off" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/admin/order-codes/review", { system: CPT, code: "82274", decision: "APPROVE", note: "owner sign-off" }),
    );
  });

  it("offers Revoke on an approved code and no action on a listed-only one", async () => {
    render(<OrderCodesAdmin />);
    const colo = await screen.findByTestId("order-code-45378");
    expect(within(colo).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(within(colo).queryByRole("button", { name: "Approve" })).toBeNull();
    const local = screen.getByTestId("order-code-bp");
    expect(within(local).queryByRole("button")).toBeNull();
    expect(within(local).getByText(/never on a card/)).toBeInTheDocument();
  });
});
