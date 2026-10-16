import { describe, expect, it } from "vitest";
import { dueSoonPossible, type MeasureListItem } from "@/lib/measure-identity";

const EXECUTED = { ecqmId: "CMS125FHIR", version: "1.0.000", status: "draft" as const, statusNote: null, derivedFrom: "CMS125v14" };
const official = (id: string, status = "Active"): MeasureListItem => ({ id, name: id, status, identity: { cmsId: id.toUpperCase(), mipsQualityId: null, executed: EXECUTED } });
// A CMS measure on a stack that does not route it runs authored CQL, like an occupational one.
const authored = (id: string, status = "Active"): MeasureListItem => ({ id, name: id, status, identity: id.startsWith("cms") ? { cmsId: id.toUpperCase(), mipsQualityId: null } : null });

describe("dueSoonPossible", () => {
  it("is false where every active measure runs CMS's logic (Maui)", () => {
    expect(dueSoonPossible([official("cms125"), official("cms2"), official("cms137")], "")).toBe(false);
  });

  it("is true when any active measure runs authored CQL (TWH)", () => {
    expect(dueSoonPossible([official("cms125"), authored("audiogram")], "")).toBe(true);
    expect(dueSoonPossible([authored("cms130")], "")).toBe(true);
  });

  it("follows the selected measure, not the catalog", () => {
    const catalog = [official("cms125"), authored("audiogram")];
    expect(dueSoonPossible(catalog, "cms125")).toBe(false);
    expect(dueSoonPossible(catalog, "audiogram")).toBe(true);
  });

  it("ignores measures that are not active when none is selected", () => {
    expect(dueSoonPossible([official("cms125"), authored("draft-one", "Draft"), authored("old", "Deprecated")], "")).toBe(false);
  });

  it("never hides the option when it cannot tell: catalog not loaded, or a measure it does not list", () => {
    expect(dueSoonPossible([], "")).toBe(true);
    expect(dueSoonPossible([], "cms125")).toBe(true);
    expect(dueSoonPossible([official("cms125")], "unknown")).toBe(true);
  });
});
