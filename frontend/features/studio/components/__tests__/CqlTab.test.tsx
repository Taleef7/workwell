import React, { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { MeasureDetail } from "../../types";
import type { ApiClient } from "@/lib/api/client";

// Monaco is heavy and unnecessary here; stub the dynamic editor so the tab renders in jsdom.
vi.mock("next/dynamic", () => ({
  default: () => function MockMonacoEditor() {
    return null;
  },
}));
vi.mock("@monaco-editor/react", () => ({ default: () => null }));

import { CqlTab } from "../CqlTab";

const baseMeasure: MeasureDetail = {
  id: "m1",
  name: "Annual Audiogram Completed",
  policyRef: "OSHA 29 CFR 1910.95",
  oshaReferenceId: null,
  version: "1.0",
  status: "Draft",
  owner: "Safety",
  description: "Annual audiogram.",
  eligibilityCriteria: { roleFilter: "Tech", siteFilter: "Plant A", programEnrollmentText: "In Program" },
  exclusions: [],
  complianceWindow: "365 days",
  requiredDataElements: [],
  cqlText: "library Audiogram version '1.0'",
  compileStatus: "NOT_COMPILED",
  valueSets: [],
  testFixtures: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Mirrors the parent page wiring: the live compile status is held in parent state and
// fed back into the tab as a prop, so the badge reflects the compile response without remount.
function CqlHarness({ api }: { api: Partial<ApiClient> }) {
  const [liveCompileStatus, setLiveCompileStatus] = useState<string | null>(null);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compileWarnings, setCompileWarnings] = useState<string[]>([]);
  return (
    <CqlTab
      measure={baseMeasure}
      measureId="m1"
      api={api as ApiClient}
      cqlText={baseMeasure.cqlText}
      onCqlChange={() => {}}
      compileErrors={compileErrors}
      compileWarnings={compileWarnings}
      onCompileErrors={setCompileErrors}
      onCompileWarnings={setCompileWarnings}
      onCompiled={() => {}}
      onError={() => {}}
      canClone={false}
      onCreateNewVersion={async () => true}
      liveCompileStatus={liveCompileStatus}
      onCompileStatusChange={setLiveCompileStatus}
    />
  );
}

describe("CqlTab compile status badge", () => {
  it("flips from the persisted status to the live compile response (NOT_COMPILED → WARNINGS) without remount", async () => {
    const post = vi.fn().mockResolvedValue({ status: "WARNINGS", warnings: ["Line 1, Column 1: WARNING: heads up"], errors: [] });
    render(<CqlHarness api={{ post }} />);

    const badge = screen.getByTestId("compile-status-badge");
    expect(badge.textContent).toBe("NOT COMPILED");

    fireEvent.click(screen.getByRole("button", { name: "Compile" }));

    await waitFor(() => expect(screen.getByTestId("compile-status-badge").textContent).toBe("WARNINGS"));
    // WARNINGS must be visually distinct (amber), never the ERROR red style.
    const flipped = screen.getByTestId("compile-status-badge");
    expect(flipped.className).toContain("amber");
    expect(flipped.className).not.toContain("red");
  });

  it("shows an in-flight 'Compiling…' state and disables the Compile button while pending", async () => {
    const d = deferred<{ status: string; warnings: string[]; errors: string[] }>();
    const post = vi.fn().mockReturnValue(d.promise);
    render(<CqlHarness api={{ post }} />);

    fireEvent.click(screen.getByRole("button", { name: "Compile" }));

    const compilingButton = await screen.findByRole("button", { name: /Compiling/ });
    expect(compilingButton).toBeDisabled();

    d.resolve({ status: "COMPILED", warnings: [], errors: [] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Compile" })).toBeEnabled());
  });
});
