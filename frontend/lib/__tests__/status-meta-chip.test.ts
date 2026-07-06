import { describe, expect, it } from "vitest";
import { metaChipClass, outcomeStatusClass } from "@/lib/status";

// UX-14: passive/metadata chips (outreach-delivery status: NOT SENT / SIMULATED / SENT / QUEUED /
// FAILED) get a lighter visual tier than actionable worklist status chips (OVERDUE, DUE_SOON, ...).
describe("metaChipClass — passive metadata chip tier (UX-14)", () => {
  it("uses a lighter weight than the actionable status tier", () => {
    // actionable roster/case/outcome chips render font-semibold; passive meta chips are font-medium
    expect(metaChipClass("SENT")).toContain("font-medium");
    expect(metaChipClass("SENT")).not.toContain("font-semibold");
  });

  it("uses a subtle outline + muted fill, not a saturated fill", () => {
    // an actionable outcome chip has a saturated *-100 fill; the meta tier must not
    expect(outcomeStatusClass("OVERDUE")).toContain("bg-rose-100");
    for (const s of ["SENT", "FAILED", "QUEUED", "SIMULATED", "NOT_SENT"]) {
      expect(metaChipClass(s)).toContain("border");
      expect(metaChipClass(s)).not.toContain("-100");
    }
  });

  it("keeps a status-specific accent (color + text pairing preserved, no color-only info)", () => {
    expect(metaChipClass("SENT")).toContain("emerald");
    expect(metaChipClass("FAILED")).toContain("rose");
    expect(metaChipClass("SIMULATED")).toContain("sky");
    expect(metaChipClass("QUEUED")).toContain("amber");
    // NOT SENT / null default is the most passive: neutral, no fill
    expect(metaChipClass(null)).toContain("neutral");
  });

  it("is dark-mode aware", () => {
    expect(metaChipClass("SENT")).toContain("dark:");
    expect(metaChipClass("NOT_SENT")).toContain("dark:");
  });

  it("normalizes loose casing/spacing to the same tier", () => {
    expect(metaChipClass("sent")).toBe(metaChipClass("SENT"));
  });
});
