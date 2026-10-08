import { describe, it, expect } from "vitest";
import {
  formatMeasureIdentity,
  formatMeasureLabel,
  formatVersionedIdentity,
  type MeasureIdentity,
  type ScoringLogic,
} from "./measure-identity";

describe("formatMeasureIdentity", () => {
  it("formats 'MIPS 112 · CMS125' when identity has MIPS", () => {
    const identity: MeasureIdentity = { cmsId: "CMS125", mipsQualityId: "112" };
    expect(formatMeasureIdentity(identity)).toBe("MIPS 112 · CMS125");
  });

  it("formats 'CMS125' when mipsQualityId is null", () => {
    const identity: MeasureIdentity = { cmsId: "CMS125", mipsQualityId: null };
    expect(formatMeasureIdentity(identity)).toBe("CMS125");
  });

  it("returns '' when identity is null", () => {
    expect(formatMeasureIdentity(null)).toBe("");
  });

  it("returns '' when identity is undefined", () => {
    expect(formatMeasureIdentity(undefined)).toBe("");
  });
});

describe("formatMeasureLabel", () => {
  it("formats MIPS · CMS · Name when identity has MIPS", () => {
    const identity: MeasureIdentity = { cmsId: "CMS125", mipsQualityId: "112" };
    expect(formatMeasureLabel(identity, "Breast Cancer Screening")).toBe(
      "MIPS 112 · CMS125 · Breast Cancer Screening"
    );
  });

  it("formats CMS · Name when identity has no MIPS Quality ID (null)", () => {
    const identity: MeasureIdentity = { cmsId: "CMS125", mipsQualityId: null };
    expect(formatMeasureLabel(identity, "Breast Cancer Screening")).toBe(
      "CMS125 · Breast Cancer Screening"
    );
  });

  it("returns plain name when identity is null", () => {
    expect(formatMeasureLabel(null, "Annual Audiogram Completed")).toBe(
      "Annual Audiogram Completed"
    );
  });

  it("returns plain name when identity is undefined", () => {
    expect(formatMeasureLabel(undefined, "HAZWOPER Surveillance")).toBe(
      "HAZWOPER Surveillance"
    );
  });
});

describe("formatVersionedIdentity (#769)", () => {
  const cms137: MeasureIdentity = {
    cmsId: "CMS137",
    mipsQualityId: "305",
    // Today's routing names CMS's artifact; the label must never read it in place of the row's logic.
    executed: { ecqmId: "CMS137FHIR", version: "1.0.000", status: "draft", statusNote: null, derivedFrom: "CMS137v14" },
  };
  const cmsLogic: ScoringLogic = {
    kind: "cms-artifact",
    ecqmId: "CMS137FHIR",
    version: "1.0.000",
    derivedFrom: "CMS137v14",
    status: "draft",
    statusNote: "posted for public comment Jan–Feb 2026",
  };
  const translation: ScoringLogic = {
    kind: "workwell-translation",
    label: "WorkWell translation of CMS137v15",
    version: "ww-2027.1",
    url: "urn:workwell:measure:cms137:translation",
    derivedFrom: "CMS137v15",
  };

  it("names CMS's artifact with its version and the QDM measure it came from", () => {
    expect(formatVersionedIdentity(cms137, cmsLogic)).toEqual({
      short: "MIPS 305 · CMS137FHIR (from CMS137v14)",
      full: "MIPS 305 · CMS137FHIR v1.0.000 (from CMS137v14)",
      title: "MIPS 305 · CMS137FHIR v1.0.000 (from CMS137v14), a CMS draft",
    });
  });

  it("names a translated result by the translation, even where today's routing says CMS's artifact", () => {
    expect(formatVersionedIdentity(cms137, translation)).toEqual({
      short: "MIPS 305 · WW translation of CMS137v15",
      full: "MIPS 305 · WorkWell translation of CMS137v15 (ww-2027.1)",
      title: "MIPS 305 · WorkWell translation of CMS137v15 (ww-2027.1), not a CMS measure",
    });
    expect(formatVersionedIdentity(cms137, translation)?.full).not.toContain("CMS137FHIR");
  });

  it("without the row's logic it is the unversioned crosswalk, never a version taken from routing", () => {
    expect(formatVersionedIdentity(cms137, null)).toEqual({ short: "MIPS 305 · CMS137", full: "MIPS 305 · CMS137", title: "MIPS 305 · CMS137" });
    expect(formatVersionedIdentity(cms137, undefined)?.full).toBe("MIPS 305 · CMS137");
  });

  it("an artifact with no pinned lineage keeps its own version on the chip", () => {
    expect(formatVersionedIdentity(cms137, { ...cmsLogic, derivedFrom: null, status: "unknown" })).toEqual({
      short: "MIPS 305 · CMS137FHIR v1.0.000",
      full: "MIPS 305 · CMS137FHIR v1.0.000",
      title: "MIPS 305 · CMS137FHIR v1.0.000",
    });
  });

  it("a measure with no CMS identity is not labelled at all", () => {
    expect(formatVersionedIdentity(null, cmsLogic)).toBeNull();
    expect(formatVersionedIdentity(undefined, null)).toBeNull();
  });
});

