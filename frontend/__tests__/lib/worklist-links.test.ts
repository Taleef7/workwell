import { describe, expect, it } from "vitest";
import { casesHref, worklistHref } from "@/lib/worklist-links";

describe("links between the work list, Cases and Compliance (#698)", () => {
  it("carries the measure, a gap status, the site, the PCP and the search", () => {
    expect(worklistHref({ measureId: "cms125", outcome: "OVERDUE", site: "Kihei Clinic" })).toBe("/worklist?measureId=cms125&outcome=OVERDUE&site=Kihei+Clinic");
    expect(casesHref({ measureId: "cms125", outcome: "due_soon", providerId: "pcp-7", search: " smith " })).toBe(
      "/cases?measureId=cms125&outcome=DUE_SOON&providerId=pcp-7&search=smith",
    );
  });

  it("drops a status that is not a gap, and empty parts", () => {
    for (const status of ["COMPLIANT", "EXCLUDED", "ALL", ""]) expect(worklistHref({ measureId: "cms2", outcome: status })).toBe("/worklist?measureId=cms2");
    expect(worklistHref({})).toBe("/worklist");
    expect(worklistHref({ measureId: "", outcome: null, site: "", search: "  " })).toBe("/worklist");
  });

  it("asks for the whole practice when the link comes from a practice-wide count", () => {
    expect(worklistHref({ measureId: "cms2", wholePractice: true })).toBe("/worklist?measureId=cms2&panel=all");
    expect(worklistHref({ measureId: "cms2" })).toBe("/worklist?measureId=cms2");
  });

  it("opens either list's closed-by-staff view on request", () => {
    expect(casesHref({ measureId: "cms2", staffClosed: true })).toBe("/cases?measureId=cms2&status=staff_closed");
    expect(worklistHref({ measureId: "cms2", staffClosed: true })).toBe("/worklist?measureId=cms2&status=staff_closed");
  });
});
