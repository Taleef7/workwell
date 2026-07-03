import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SpecTab } from "../SpecTab";
import type { MeasureDetail } from "../../types";
import type { ApiClient } from "@/lib/api/client";

const sampleMeasure: MeasureDetail = {
  id: "m1",
  name: "Annual Audiogram Completed",
  policyRef: "OSHA 29 CFR 1910.95",
  oshaReferenceId: null,
  version: "1.0",
  status: "Draft",
  owner: "Safety",
  description: "Annual audiogram for employees in hearing conservation.",
  eligibilityCriteria: {
    roleFilter: "Safety Technician",
    siteFilter: "Plant A",
    programEnrollmentText: "In Hearing Conservation Program",
  },
  exclusions: [{ label: "Active Waiver", criteriaText: "Has Active Waiver" }],
  complianceWindow: "365 days",
  requiredDataElements: ["Audiogram Date", "Waiver Status"],
  cqlText: "",
  compileStatus: "COMPILED",
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

function renderSpecTab(api: Partial<ApiClient>, canAuthor = true) {
  return render(
    <SpecTab
      measure={sampleMeasure}
      measureId="m1"
      api={api as ApiClient}
      oshaReferences={[]}
      onSaved={() => {}}
      onError={() => {}}
      canAuthor={canAuthor}
    />
  );
}

const SPEC_FIELD_LABELS = [
  "Description",
  "Eligibility Role Filter",
  "Eligibility Site Filter",
  "Program Enrollment Text",
  "Exclusion Label",
  "Exclusion Criteria Text",
  "Compliance Window",
  "Required Data Elements",
];

describe("SpecTab", () => {
  it("renders an accessible <label> associated with each spec field", () => {
    renderSpecTab({ post: vi.fn(), put: vi.fn() });
    for (const labelText of SPEC_FIELD_LABELS) {
      // getByLabelText resolves the control only when a <label htmlFor> is wired to its id.
      expect(screen.getByLabelText(labelText)).toBeInTheDocument();
    }
  });

  it("Fable H10: a non-author (canAuthor=false) sees the Save + AI Draft controls disabled, not a 403", () => {
    renderSpecTab({ post: vi.fn(), put: vi.fn() }, false);
    expect(screen.getByRole("button", { name: "Save Draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI Draft Spec" })).toBeDisabled();
  });

  it("shows an in-flight 'Saving…' state on the Save Draft button while the save is pending", async () => {
    const d = deferred<unknown>();
    const put = vi.fn().mockReturnValue(d.promise);
    renderSpecTab({ post: vi.fn(), put });

    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    const savingButton = await screen.findByRole("button", { name: /Saving/ });
    expect(savingButton).toBeDisabled();
    expect(put).toHaveBeenCalledTimes(1);

    d.resolve(undefined);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Draft" })).toBeEnabled());
  });

  it("shows an in-flight 'Drafting…' state on the AI Draft Spec button while the draft is pending", async () => {
    const d = deferred<unknown>();
    const post = vi.fn().mockReturnValue(d.promise);
    renderSpecTab({ post, put: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "AI Draft Spec" }));

    const draftingButton = await screen.findByRole("button", { name: /Drafting/ });
    expect(draftingButton).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);

    d.resolve({ success: false, fallback: "AI temporarily unavailable. Please fill the spec manually." });
    await waitFor(() => expect(screen.getByRole("button", { name: "AI Draft Spec" })).toBeEnabled());
  });
});
