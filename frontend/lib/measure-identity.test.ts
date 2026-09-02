import { describe, it, expect } from "vitest";
import {
  formatMeasureIdentity,
  formatMeasureLabel,
  type MeasureIdentity,
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
