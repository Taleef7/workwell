import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeliveryChip } from "./DeliveryChip";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";

// UX-14: the outreach-delivery chip is passive delivery metadata, so it renders in the lighter `meta`
// tier — a visible contrast against an actionable worklist status chip.
describe("DeliveryChip (UX-14 passive meta tier)", () => {
  it("renders NOT SENT in the passive meta tier (lighter weight + outline, no saturated fill)", () => {
    const { getByText } = render(<DeliveryChip status={null} />);
    // label is unchanged from the pre-UX-14 case-detail render (formatStatusLabel, no re-casing)
    const chip = getByText("NOT SENT");
    expect(chip.className).toContain("font-medium");
    expect(chip.className).not.toContain("font-semibold");
    expect(chip.className).toContain("border");
  });

  it("keeps the delivery label + a status accent (SENT)", () => {
    const { getByText } = render(<DeliveryChip status="SENT" />);
    const chip = getByText("SENT");
    expect(chip.className).toContain("emerald");
    expect(chip.className).toContain("font-medium");
  });

  it("preserves an explicit raw label (admin delivery log keeps SIMULATED uppercase)", () => {
    const { getByText } = render(<DeliveryChip status="SIMULATED" label="SIMULATED" size="xs" />);
    const chip = getByText("SIMULATED");
    expect(chip.className).toContain("font-medium");
    expect(chip.className).toContain("text-[10px]");
  });

  it("actionable status chips stay in the louder semibold tier — the contrast the tier creates", () => {
    const { getByText } = render(<ComplianceChip cell={{ status: "OVERDUE", method: "" }} />);
    const chip = getByText("Overdue");
    expect(chip.className).toContain("font-semibold");
  });
});
