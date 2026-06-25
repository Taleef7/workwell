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
});
