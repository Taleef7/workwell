import { describe, expect, it } from "vitest";
import { payerGroupButtonLabel } from "../use-panel-payers";

/**
 * #583 — the group button must not offer a hierarchical family under the name of its parent alone.
 *
 * On the pilot roster "Medicare" is typology code `1` (traditional, 3,927) plus `11` (Medicare
 * Advantage, 2,900) plus `12`. The button read "All Medicare (6,827)" and put the member codes only
 * in a `title` tooltip, so a quality lead reading it as their attributed population picked up ~2,900
 * people who may not be in it, with nothing on screen to say so.
 */
describe("payerGroupButtonLabel", () => {
  const medicare = { groupName: "Medicare", codes: ["1", "11", "12"], subjectCount: 6827 };
  const selfPay = { groupName: "Self-pay", codes: ["8"], subjectCount: 114 };

  it("names how many codes a multi-code group selects, in the VISIBLE label", () => {
    const label = payerGroupButtonLabel(medicare, false);
    expect(label).toBe("All 3 Medicare codes (6,827)");
    // The failure this replaces: a label that claims the parent category and silently takes its children.
    expect(label).not.toBe("All Medicare (6,827)");
  });

  it("leaves a single-code group's plain name alone — it was never ambiguous", () => {
    expect(payerGroupButtonLabel(selfPay, false)).toBe("All Self-pay (114)");
    expect(payerGroupButtonLabel(selfPay, true)).toBe("Clear Self-pay");
  });

  it("carries the same distinction into the selected state", () => {
    expect(payerGroupButtonLabel(medicare, true)).toBe("Clear Medicare codes");
  });

  it("states the mechanism and asserts nothing about attribution", () => {
    // Whether Medicare Advantage belongs in an MSSP attributed population is an ACO question
    // (#583 / ROADMAP §7.5 input 4). A filter caption must not answer it.
    const label = payerGroupButtonLabel(medicare, false);
    for (const forbidden of ["MSSP", "ACO", "attributed", "Advantage"]) {
      expect(label).not.toContain(forbidden);
    }
  });
});
