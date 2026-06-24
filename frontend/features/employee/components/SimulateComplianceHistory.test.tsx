import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

import { SimulateComplianceHistory } from "./SimulateComplianceHistory";

const snapshotFor = (asOf: string) => ({
  externalId: "emp-001",
  asOf,
  evaluations: [
    { measureId: "audiogram", name: "Audiogram", complianceClass: "RECURRING", status: "OVERDUE", method: "Overdue — last 2024-01-01" },
    { measureId: "mmr", name: "MMR", complianceClass: "PERMANENT", status: "COMPLIANT", method: "2 valid dose(s)" }
  ]
});

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) =>
    Promise.resolve(snapshotFor(new URL(`http://x${url}`).searchParams.get("asOf") ?? "")));
});
afterEach(() => vi.clearAllMocks());

describe("SimulateComplianceHistory", () => {
  it("renders the advisory panel and a chip per simulated measure", async () => {
    render(<SimulateComplianceHistory externalId="emp-001" />);
    expect(screen.getByText("Simulate Compliance History")).toBeInTheDocument();
    expect(await screen.findByText("Audiogram")).toBeInTheDocument();
    expect(screen.getByText("MMR")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Compliant")).toBeInTheDocument();
  });

  it("refetches with the new asOf when the date changes", async () => {
    render(<SimulateComplianceHistory externalId="emp-001" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/as of/i), { target: { value: "2030-01-01" } });
    await waitFor(() => expect(String(get.mock.calls.at(-1)?.[0] ?? "")).toContain("asOf=2030-01-01"));
  });

  it("shows an error when the simulation fails", async () => {
    get.mockReset().mockRejectedValue(new Error("boom"));
    render(<SimulateComplianceHistory externalId="emp-001" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("a stale (out-of-order) response cannot overwrite the latest selection", async () => {
    // Hold each request open so we control resolution order.
    const pending: Record<string, (snap: unknown) => void> = {};
    get.mockReset().mockImplementation((url: string) => {
      const asOf = new URL(`http://x${url}`).searchParams.get("asOf") ?? "";
      return new Promise((resolve) => { pending[asOf] = resolve; });
    });

    render(<SimulateComplianceHistory externalId="emp-001" />);
    // The mount request fires after the debounce; capture its (today's) date.
    await waitFor(() => expect(Object.keys(pending).length).toBe(1));
    const firstDate = Object.keys(pending)[0]!;

    // Scrub to a newer date → a second request goes out while the first is still in flight.
    fireEvent.change(screen.getByLabelText(/as of/i), { target: { value: "2030-01-01" } });
    await waitFor(() => expect(pending["2030-01-01"]).toBeDefined());

    // Resolve the NEWEST first, then the STALE first request — the stale one must be ignored.
    pending["2030-01-01"]!(snapshotFor("2030-01-01"));
    pending[firstDate]!(snapshotFor(firstDate));

    await waitFor(() => expect(screen.getByText(`Showing compliance as of 2030-01-01`)).toBeInTheDocument());
    expect(screen.queryByText(`Showing compliance as of ${firstDate}`)).not.toBeInTheDocument();
  });
});
