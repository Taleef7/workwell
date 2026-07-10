import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StandardsTab } from "../StandardsTab";
import type { ApiClient } from "@/lib/api/client";

const fidelity = {
  available: true,
  measureId: "cms122",
  ecqmId: "CMS122v14",
  title: "Diabetes: Glycemic Status Assessment Greater Than 9%",
  version: "1.0.0",
  steward: "CMS",
  criteria: [
    { population: "Initial Population", key: "ipp", description: "Patients 18-75 with diabetes", coverage: "COVERED", note: "n", valueSetOids: [] },
    { population: "Denominator Exclusions", key: "denex", description: "Hospice", coverage: "OMITTED", note: "no hospice data in synthetic dataset", valueSetOids: [] },
  ],
  valueSets: [{ name: "Diabetes", oid: "2.16.840.1", concept: "diabetes", workwellRepresented: true, note: "" }],
  summary: { covered: 1, simplified: 0, omitted: 1, officialValueSetCount: 21, workwellValueSetCount: 18, headline: "1 of 2 criteria covered" },
  disclaimer: "Structural/definitional fidelity diff.",
};

const diff = {
  measureId: "cms122",
  ecqmId: "CMS122v14",
  runId: "run-1",
  asOf: "2026-06-30",
  totalSubjectsEvaluated: 100,
  totalDivergent: 12,
  criterionImpacts: [{ key: "denex", population: "Denominator Exclusions", coverage: "OMITTED", verifiable: true, subjectsAffected: 12, note: "n" }],
  headline: "12 subjects would change if official criteria applied",
  disclaimer: "…",
};

const executionDiff = {
  mode: "subset",
  measureId: "cms122",
  ecqmId: "CMS122v14",
  runId: "run-1",
  asOf: "2026-06-30",
  totalSubjectsEvaluated: 3,
  totalDivergent: 2,
  totalErrors: 0,
  byGate: { "qualifying-visit": 1, "hba1c-missing-counts-numerator": 1 },
  subjects: [
    { subjectId: "emp-001", workwellOutcome: "COMPLIANT", officialOutcome: "MISSING_DATA", diverged: true, divergenceGate: "qualifying-visit" },
    { subjectId: "emp-002", workwellOutcome: "MISSING_DATA", officialOutcome: "OVERDUE", diverged: true, divergenceGate: "hba1c-missing-counts-numerator" },
    { subjectId: "emp-003", workwellOutcome: "COMPLIANT", officialOutcome: "COMPLIANT", diverged: false, divergenceGate: "" },
  ],
  headline: "Executed the official-subset CMS122v14 against 3 subjects…",
  disclaimer: "Real execution diff…",
};

function mockApi(byUrl: Record<string, unknown>): Partial<ApiClient> {
  // Cast around ApiClient.get's generic <T> signature — the mock dispatches by URL.
  const get = ((url: string) => Promise.resolve(byUrl[url])) as unknown as ApiClient["get"];
  return { get };
}

describe("StandardsTab", () => {
  it("renders the fidelity report, coverage counts, and the outcome diff", async () => {
    render(
      <StandardsTab
        measureId="cms122"
        api={mockApi({
          "/api/measures/cms122/fidelity": fidelity,
          "/api/measures/cms122/fidelity/diff": diff,
        }) as ApiClient}
      />,
    );
    expect(await screen.findByText(/CMS122v14/)).toBeInTheDocument();
    expect(screen.getByText(/1 Covered/)).toBeInTheDocument();
    expect(screen.getByText(/1 Omitted/)).toBeInTheDocument();
    expect(screen.getByText(/18 of 21 represented/)).toBeInTheDocument();
    expect(await screen.findByText(/12 subjects would change/)).toBeInTheDocument();
  });

  it("renders the per-subject execution divergence when the diff is in execution mode", async () => {
    render(
      <StandardsTab
        measureId="cms122"
        api={mockApi({
          "/api/measures/cms122/fidelity": fidelity,
          "/api/measures/cms122/fidelity/diff": executionDiff,
        }) as ApiClient}
      />,
    );
    expect(await screen.findByText(/Executed the official-subset/)).toBeInTheDocument();
    // Divergent count / summary.
    expect(screen.getByText(/2 of 3/)).toBeInTheDocument();
    // Per-subject row.
    const row = screen.getByText("emp-001").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("COMPLIANT")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("MISSING_DATA")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("qualifying-visit")).toBeInTheDocument();
  });

  it("surfaces failed evaluations when the execution diff reports errors", async () => {
    render(
      <StandardsTab
        measureId="cms122"
        api={mockApi({
          "/api/measures/cms122/fidelity": fidelity,
          "/api/measures/cms122/fidelity/diff": { ...executionDiff, totalErrors: 2 },
        }) as ApiClient}
      />,
    );
    expect(await screen.findByText(/Executed the official-subset/)).toBeInTheDocument();
    expect(screen.getByText(/2 subjects failed to evaluate/)).toBeInTheDocument();
  });

  it("shows a clean message when no official reference is registered", async () => {
    render(
      <StandardsTab
        measureId="audiogram"
        api={mockApi({
          "/api/measures/audiogram/fidelity": { available: false },
          "/api/measures/audiogram/fidelity/diff": { available: false },
        }) as ApiClient}
      />,
    );
    expect(await screen.findByText(/No official eCQM reference is registered/)).toBeInTheDocument();
  });
});
