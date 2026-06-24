import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
const apiMock = { getWithHeaders, get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

const authState = { role: "ROLE_ADMIN" as string | null };
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: authState.role ? { role: authState.role } : null }) }));

import { IndividualComplianceStatus } from "./IndividualComplianceStatus";

function rosterFor(panel: string, measureId: string, name: string, status: string, method: string, outcomeId = "oc-1") {
  return {
    data: {
      panel,
      columns: [{ measureId, name, complianceClass: "PERMANENT" }],
      rows: [{
        subject: { externalId: "emp-001", name: "Ada Lovelace", role: "Nurse", site: "HQ" },
        cells: { [measureId]: { status, method, evidenceRef: { runId: "run-7", outcomeId } } }
      }]
    },
    headers: new Headers({ "X-Total-Count": "1" })
  };
}

beforeEach(() => {
  authState.role = "ROLE_ADMIN";
  getWithHeaders.mockReset().mockImplementation((url: string) => {
    if (url.includes("panel=immunizations")) return Promise.resolve(rosterFor("immunizations", "mmr", "MMR", "COMPLIANT", "2 valid dose(s)"));
    if (url.includes("panel=osha")) return Promise.resolve(rosterFor("osha", "audiogram", "Audiogram", "OVERDUE", "Overdue — last 2024-01-01", "oc-2"));
    return Promise.resolve(rosterFor("wellness", "cms122", "Diabetes HbA1c", "MISSING_DATA", "No record on file", "oc-3"));
  });
  get.mockReset().mockResolvedValue({ outcomeId: "oc-1", status: "COMPLIANT", evidenceJson: { expressionResults: [{ define: "Dose Count", result: 2 }] } });
  post.mockReset().mockResolvedValue({ runId: "run-emp", status: "COMPLETED" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("IndividualComplianceStatus", () => {
  it("merges all three panels into one RULE→STATUS→METHOD table", async () => {
    render(<IndividualComplianceStatus externalId="emp-001" />);
    expect(await screen.findByText("MMR")).toBeInTheDocument();
    expect(screen.getByText("Audiogram")).toBeInTheDocument();
    expect(screen.getByText("Diabetes HbA1c")).toBeInTheDocument();
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  it("expanding a row lazy-fetches and renders the CQL evidence", async () => {
    render(<IndividualComplianceStatus externalId="emp-001" />);
    const infoButtons = await screen.findAllByRole("button", { name: /info/i });
    await userEvent.click(infoButtons[0]);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/outcomes/oc-1"));
    expect(await screen.findByText("Dose Count")).toBeInTheDocument();
  });

  it("Recalculate posts an EMPLOYEE run, then refetches and notifies the parent", async () => {
    const onRecalculated = vi.fn();
    render(<IndividualComplianceStatus externalId="emp-001" onRecalculated={onRecalculated} />);
    await screen.findByText("MMR");
    getWithHeaders.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /recalculate/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runs/manual", { scopeType: "EMPLOYEE", employeeExternalId: "emp-001" }));
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalled());
    expect(onRecalculated).toHaveBeenCalled();
  });

  it("hides Recalculate for roles that cannot run measures", async () => {
    authState.role = "ROLE_VIEWER";
    render(<IndividualComplianceStatus externalId="emp-001" />);
    await screen.findByText("MMR");
    expect(screen.queryByRole("button", { name: /recalculate/i })).not.toBeInTheDocument();
  });

  it("renders the surviving panels when one panel fetch fails (card never blanks)", async () => {
    getWithHeaders.mockReset().mockImplementation((url: string) => {
      if (url.includes("panel=immunizations")) return Promise.reject(new Error("panel down"));
      if (url.includes("panel=osha")) return Promise.resolve(rosterFor("osha", "audiogram", "Audiogram", "OVERDUE", "Overdue — last 2024-01-01", "oc-2"));
      return Promise.resolve(rosterFor("wellness", "cms122", "Diabetes HbA1c", "MISSING_DATA", "No record on file", "oc-3"));
    });
    render(<IndividualComplianceStatus externalId="emp-001" />);
    expect(await screen.findByText("Audiogram")).toBeInTheDocument();
    expect(screen.getByText("Diabetes HbA1c")).toBeInTheDocument();
    expect(screen.queryByText("MMR")).not.toBeInTheDocument();
    expect(screen.queryByText("No evaluated measures for this employee yet.")).not.toBeInTheDocument();
  });

  it("shows 'Evidence unavailable' when the evidence fetch fails", async () => {
    get.mockReset().mockRejectedValue(new Error("boom"));
    render(<IndividualComplianceStatus externalId="emp-001" />);
    const infoButtons = await screen.findAllByRole("button", { name: /info/i });
    await userEvent.click(infoButtons[0]);
    expect(await screen.findByText("Evidence unavailable.")).toBeInTheDocument();
  });
});
