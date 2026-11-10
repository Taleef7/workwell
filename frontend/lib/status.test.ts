import { describe, expect, it } from "vitest";
import { closedReasonLabel } from "./status";

describe("closedReasonLabel", () => {
  it("words the system closures a person would otherwise read as a raw code", () => {
    expect(closedReasonLabel("CYCLE_ROLLED_OVER")).toBe("The measurement year ended");
    // #889: a retired measure's case was closed because the measure stopped being reported, not met.
    expect(closedReasonLabel("MEASURE_RETIRED")).toBe("The measure is no longer reported");
  });

  it("passes an unknown reason through and shows a dash for none", () => {
    expect(closedReasonLabel("MANUAL_RESOLVE")).toBe("MANUAL_RESOLVE");
    expect(closedReasonLabel(null)).toBe("-");
  });
});
