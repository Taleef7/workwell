import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWithHeaders = vi.fn();
// Mirror the real memoized useApi() with a STABLE object (so effect deps don't churn).
const apiMock = { getWithHeaders };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

import { IndividualComplianceStatus } from "./IndividualComplianceStatus";

function rosterFor(panel: string, measureId: string, name: string, status: string, method: string) {
  return {
    data: {
      panel,
      columns: [{ measureId, name, complianceClass: "PERMANENT" }],
      rows: [
        {
          subject: { externalId: "emp-001", name: "Ada Lovelace", role: "Nurse", site: "HQ" },
          cells: { [measureId]: { status, method, evidenceRef: { runId: "run-7", outcomeId: "o-1" } } }
        }
      ]
    },
    headers: new Headers({ "X-Total-Count": "1" })
  };
}

beforeEach(() => {
  getWithHeaders.mockReset().mockImplementation((url: string) => {
    if (url.includes("panel=immunizations")) return Promise.resolve(rosterFor("immunizations", "mmr", "MMR", "COMPLIANT", "2 valid dose(s)"));
    if (url.includes("panel=osha")) return Promise.resolve(rosterFor("osha", "audiogram", "Audiogram", "OVERDUE", "Overdue — last 2024-01-01"));
    return Promise.resolve(rosterFor("wellness", "cms122", "Diabetes HbA1c", "MISSING_DATA", "No record on file"));
  });
});
afterEach(() => vi.clearAllMocks());

describe("IndividualComplianceStatus", () => {
  it("merges all three panels into one RULE→STATUS→METHOD table", async () => {
    render(<IndividualComplianceStatus externalId="emp-001" />);
    expect(await screen.findByText("Individual Compliance Status")).toBeInTheDocument();
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalledTimes(3));
    expect(screen.getByText("MMR")).toBeInTheDocument();
    expect(screen.getByText("Audiogram")).toBeInTheDocument();
    expect(screen.getByText("Diabetes HbA1c")).toBeInTheDocument();
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  it("expands a row to reveal the source run id", async () => {
    render(<IndividualComplianceStatus externalId="emp-001" />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalledTimes(3));
    await userEvent.click(screen.getAllByRole("button", { name: /info/i })[0]);
    expect(await screen.findByText(/run-7/)).toBeInTheDocument();
  });
});
