import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuleBuilderTab } from "../RuleBuilderTab";
import type { MeasureDetail } from "../../types";
import type { ApiClient } from "@/lib/api/client";

const base: MeasureDetail = {
  id: "mmr", name: "MMR", policyRef: "x", oshaReferenceId: null, version: "1.0.0", status: "Draft",
  owner: "o", description: "", eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" },
  exclusions: [], complianceWindow: "", requiredDataElements: [], cqlText: "", compileStatus: "COMPILED",
  valueSets: [], testFixtures: [],
  rule: { type: "series-completion", requiredDoses: 2 },
  ruleBindings: {
    enrollment: { code: "immz-enrolled", valueSet: "urn:vs:e" },
    waiver: { code: "mmr-contra", valueSet: "urn:vs:w" },
    event: { code: "mmr-vaccine", valueSet: "urn:vs:ev", type: "immunization" },
  },
};

function renderTab(api: Partial<ApiClient>, measure = base) {
  return render(<RuleBuilderTab measure={measure} measureId="mmr" api={api as ApiClient} onSaved={() => {}} onError={() => {}} />);
}

describe("RuleBuilderTab", () => {
  it("hydrates from measure.rule and previews the generated CQL", async () => {
    const post = vi.fn().mockResolvedValue({ cql: "library MmrSeries version '1.0.0'\n…define \"Dose Count\":" });
    renderTab({ post, put: vi.fn() });
    // mounted with requiredDoses=2 → a debounced preview fires
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/measures/mmr/rule/preview", expect.objectContaining({
      rule: expect.objectContaining({ type: "series-completion", requiredDoses: 2 }),
    })));
    expect(await screen.findByText(/Dose Count/)).toBeInTheDocument();
  });

  it("Save posts the rule to PUT /rule", async () => {
    const put = vi.fn().mockResolvedValue({ cql: "x", status: "COMPILED", errors: [], warnings: [] });
    renderTab({ post: vi.fn().mockResolvedValue({ cql: "x" }), put });
    fireEvent.click(screen.getByRole("button", { name: /save rule/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/measures/mmr/rule", expect.objectContaining({
      rule: expect.any(Object), bindings: expect.any(Object),
    })));
  });

  it("switching to windowed-recency reveals the window fields", async () => {
    renderTab({ post: vi.fn().mockResolvedValue({ cql: "" }), put: vi.fn() });
    fireEvent.change(screen.getByLabelText(/rule shape/i), { target: { value: "windowed-recency" } });
    expect(screen.getByLabelText(/window \(days\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/due-soon \(days\)/i)).toBeInTheDocument();
  });

  it("skips preview and disables Save when binding codes are empty", async () => {
    const post = vi.fn().mockResolvedValue({ cql: "x" });
    // No rule/ruleBindings → bindings default to empty codes.
    const bare: MeasureDetail = { ...base, rule: undefined, ruleBindings: undefined };
    renderTab({ post, put: vi.fn() }, bare);
    // give the debounce window time to (not) fire
    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitFor(() => expect(post).not.toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /save rule/i })).toBeDisabled();
  });

  it("treats a blank value set as incomplete (codes set, value sets empty)", async () => {
    const post = vi.fn().mockResolvedValue({ cql: "x" });
    // Codes present but value sets blank — codegen would compile but never match real codings.
    const noVs: MeasureDetail = {
      ...base,
      ruleBindings: {
        enrollment: { code: "immz-enrolled", valueSet: "" },
        waiver: { code: "mmr-contra", valueSet: "" },
        event: { code: "mmr-vaccine", valueSet: "", type: "immunization" },
      },
    };
    renderTab({ post, put: vi.fn() }, noVs);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitFor(() => expect(post).not.toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /save rule/i })).toBeDisabled();
  });

  it("alternative-series toggle reveals the alternatives list and emits alternatives on save", async () => {
    const put = vi.fn().mockResolvedValue({ cql: "x", status: "COMPILED", errors: [], warnings: [] });
    renderTab({ post: vi.fn().mockResolvedValue({ cql: "x" }), put });
    fireEvent.click(screen.getByLabelText(/alternative series/i));
    expect(screen.getByLabelText(/alternative 1 label/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/alternative 1 label/i), { target: { value: "Heplisav-B" } });
    fireEvent.change(screen.getByLabelText(/alternative 1 cvx codes/i), { target: { value: "189" } });
    fireEvent.click(screen.getByRole("button", { name: /save rule/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/measures/mmr/rule", expect.objectContaining({
      rule: expect.objectContaining({ alternatives: expect.arrayContaining([expect.objectContaining({ label: "Heplisav-B" })]) }),
      bindings: expect.objectContaining({ eventAlternatives: expect.any(Array) }),
    })));
  });

  it("disables Save while an alternative is incomplete, then enables it once codes are filled", async () => {
    renderTab({ post: vi.fn().mockResolvedValue({ cql: "x" }), put: vi.fn() });
    fireEvent.click(screen.getByLabelText(/alternative series/i));
    // label filled, CVX codes empty → incomplete → Save disabled
    fireEvent.change(screen.getByLabelText(/alternative 1 label/i), { target: { value: "Heplisav-B" } });
    expect(screen.getByRole("button", { name: /save rule/i })).toBeDisabled();
    // fill the codes → complete → Save enabled
    fireEvent.change(screen.getByLabelText(/alternative 1 cvx codes/i), { target: { value: "189" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /save rule/i })).toBeEnabled());
  });

  it("hydrates the alternatives sub-form from measure.rule.alternatives (correlated by label)", () => {
    const hydrated: MeasureDetail = {
      ...base,
      rule: {
        type: "series-completion",
        requiredDoses: 2,
        alternatives: [
          { label: "Heplisav-B", requiredDoses: 2, minIntervalDays: [28] },
          { label: "Traditional", requiredDoses: 3, minIntervalDays: [28, 56] },
        ],
      },
      ruleBindings: {
        enrollment: { code: "immz-enrolled", valueSet: "urn:vs:e" },
        waiver: { code: "hepb-contra", valueSet: "urn:vs:w" },
        event: { code: "hepb-vaccine", valueSet: "urn:vs:ev", type: "immunization" },
        eventAlternatives: [
          { label: "Heplisav-B", codes: [{ code: "189", valueSet: "urn:vs:ev" }] },
          { label: "Traditional", codes: [{ code: "08", valueSet: "urn:vs:ev" }, { code: "43", valueSet: "urn:vs:ev" }] },
        ],
      },
    };
    renderTab({ post: vi.fn().mockResolvedValue({ cql: "x" }), put: vi.fn() }, hydrated);
    // toggle renders ON
    expect(screen.getByLabelText(/alternative series/i)).toBeChecked();
    // row 1 populated
    expect(screen.getByLabelText(/alternative 1 label/i)).toHaveValue("Heplisav-B");
    expect(screen.getByLabelText(/alternative 1 cvx codes/i)).toHaveValue("189");
    expect(screen.getByLabelText(/alternative 1 min intervals \(days\)/i)).toHaveValue("28");
    // row 2 populated (multi-code joined)
    expect(screen.getByLabelText(/alternative 2 label/i)).toHaveValue("Traditional");
    expect(screen.getByLabelText(/alternative 2 cvx codes/i)).toHaveValue("08, 43");
    expect(screen.getByLabelText(/alternative 2 min intervals \(days\)/i)).toHaveValue("28, 56");
  });

  it("omits minIntervalDays when blank and emits it when filled", async () => {
    // blank intervals → no minIntervalDays key
    const putBlank = vi.fn().mockResolvedValue({ cql: "x", status: "COMPILED", errors: [], warnings: [] });
    const { unmount } = renderTab({ post: vi.fn().mockResolvedValue({ cql: "x" }), put: putBlank });
    fireEvent.click(screen.getByLabelText(/alternative series/i));
    fireEvent.change(screen.getByLabelText(/alternative 1 label/i), { target: { value: "Heplisav-B" } });
    fireEvent.change(screen.getByLabelText(/alternative 1 cvx codes/i), { target: { value: "189" } });
    fireEvent.click(screen.getByRole("button", { name: /save rule/i }));
    await waitFor(() => expect(putBlank).toHaveBeenCalled());
    const blankRule = putBlank.mock.calls[0][1].rule as { alternatives: Array<Record<string, unknown>> };
    expect(blankRule.alternatives[0]).not.toHaveProperty("minIntervalDays");
    unmount();

    // filled intervals → minIntervalDays === [28]
    const putFilled = vi.fn().mockResolvedValue({ cql: "x", status: "COMPILED", errors: [], warnings: [] });
    renderTab({ post: vi.fn().mockResolvedValue({ cql: "x" }), put: putFilled });
    fireEvent.click(screen.getByLabelText(/alternative series/i));
    fireEvent.change(screen.getByLabelText(/alternative 1 label/i), { target: { value: "Heplisav-B" } });
    fireEvent.change(screen.getByLabelText(/alternative 1 cvx codes/i), { target: { value: "189" } });
    fireEvent.change(screen.getByLabelText(/alternative 1 min intervals \(days\)/i), { target: { value: "28" } });
    fireEvent.click(screen.getByRole("button", { name: /save rule/i }));
    await waitFor(() => expect(putFilled).toHaveBeenCalled());
    const filledRule = putFilled.mock.calls[0][1].rule as { alternatives: Array<{ minIntervalDays?: number[] }> };
    expect(filledRule.alternatives[0].minIntervalDays).toEqual([28]);
  });
});
