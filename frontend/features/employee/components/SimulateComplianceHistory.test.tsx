import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

import { SimulateComplianceHistory } from "./SimulateComplianceHistory";

const snapshotFor = (asOf: string, notSimulated: Array<{ measureId: string; name: string }> = []) => ({
  externalId: "emp-001",
  asOf,
  evaluations: [
    { measureId: "audiogram", name: "Audiogram", complianceClass: "RECURRING", status: "OVERDUE", method: "Overdue — last 2024-01-01" },
    { measureId: "mmr", name: "MMR", complianceClass: "PERMANENT", status: "COMPLIANT", method: "2 valid dose(s)" }
  ],
  notSimulated
});

const run = () => fireEvent.click(screen.getByRole("button", { name: /run simulation/i }));

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) =>
    Promise.resolve(snapshotFor(new URL(`http://x${url}`).searchParams.get("asOf") ?? "")));
});
afterEach(() => vi.clearAllMocks());

describe("SimulateComplianceHistory", () => {
  it("evaluates nothing when the page opens (#671)", async () => {
    render(<SimulateComplianceHistory externalId="emp-001" />);
    expect(screen.getByText("Simulate Compliance History")).toBeInTheDocument();
    expect(screen.getByText(/nothing is evaluated until you do/i)).toBeInTheDocument();
    // Give a debounced fetch every chance to fire; none may.
    await new Promise((r) => setTimeout(r, 400));
    expect(get).not.toHaveBeenCalled();
  });

  it("runs on request and renders a chip per simulated measure", async () => {
    render(<SimulateComplianceHistory externalId="emp-001" />);
    run();
    expect(await screen.findByText("Audiogram")).toBeInTheDocument();
    expect(screen.getByText("MMR")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("uses the chosen date", async () => {
    render(<SimulateComplianceHistory externalId="emp-001" />);
    fireEvent.change(screen.getByLabelText(/as of/i), { target: { value: "2030-01-01" } });
    expect(get).not.toHaveBeenCalled();
    run();
    await waitFor(() => expect(String(get.mock.calls.at(-1)?.[0] ?? "")).toContain("asOf=2030-01-01"));
  });

  it("names the measures it cannot replay, with the page's measure labels", async () => {
    get.mockReset().mockResolvedValue(
      snapshotFor("2026-09-23", [
        { measureId: "cms2", name: "Depression Screening" },
        { measureId: "cms130", name: "Colorectal Cancer Screening" },
      ]),
    );
    render(
      <SimulateComplianceHistory externalId="pat-003" labelFor={(id, name) => `${id.toUpperCase()} · ${name}`} />,
    );
    run();
    const note = await screen.findByTestId("not-simulated");
    expect(note).toHaveTextContent("CMS2 · Depression Screening, CMS130 · Colorectal Cancer Screening");
    expect(note).toHaveTextContent(/can't cover these measures yet/i);
  });

  it("shows no not-simulated line when every measure was simulated", async () => {
    render(<SimulateComplianceHistory externalId="emp-001" />);
    run();
    await screen.findByText("Audiogram");
    expect(screen.queryByTestId("not-simulated")).not.toBeInTheDocument();
  });

  it("shows an error when the simulation fails", async () => {
    get.mockReset().mockRejectedValue(new Error("boom"));
    render(<SimulateComplianceHistory externalId="emp-001" />);
    run();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("one run at a time: the button is disabled while a run is in flight", async () => {
    let resolve!: (snap: unknown) => void;
    get.mockReset().mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<SimulateComplianceHistory externalId="emp-001" />);
    run();
    const button = await screen.findByRole("button", { name: /simulating/i });
    expect(button).toBeDisabled();
    // The first run says it is running, not "nothing is evaluated until you do".
    expect(screen.queryByText(/nothing is evaluated until you do/i)).not.toBeInTheDocument();
    resolve(snapshotFor("2026-09-23"));
    expect(await screen.findByRole("button", { name: /run simulation/i })).toBeEnabled();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
