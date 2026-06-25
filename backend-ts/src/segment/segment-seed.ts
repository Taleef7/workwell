/**
 * Demo risk-group seed (#183 E11.3). Idempotent by segment name: existing names are left untouched,
 * so re-running on boot is safe and operator edits are never clobbered. Seeds four cohorts mapping to
 * applicable rule-sets so the roster grid shows a meaningful applicable/N-A mix out of the box.
 */
import type { CreateSegmentInput, SegmentStore } from "../stores/segment-store.ts";

export const DEMO_SEGMENTS: CreateSegmentInput[] = [
  {
    name: "OSHA Safety-Sensitive",
    description: "Field roles in OSHA surveillance programs.",
    rule: { match: "ANY", conditions: [
      { attr: "role", op: "contains", value: "Welder" },
      { attr: "role", op: "contains", value: "Maintenance" },
      { attr: "role", op: "contains", value: "Hazwoper" },
      { attr: "role", op: "contains", value: "Industrial Hygienist" },
    ] },
    measureIds: ["audiogram", "hazwoper", "tb_surveillance"],
  },
  {
    name: "Clinical Staff",
    description: "Clinic-based and nursing staff (infection control + immunizations).",
    rule: { match: "ANY", conditions: [
      { attr: "site", op: "equals", value: "Clinic" },
      { attr: "role", op: "contains", value: "Nurse" },
    ] },
    measureIds: ["flu_vaccine", "tb_surveillance", "mmr", "varicella", "hepatitis_b_vaccination_series", "adult_immunization"],
  },
  {
    name: "Office Staff",
    description: "Administrative roles — wellness program only.",
    rule: { match: "ANY", conditions: [
      { attr: "role", op: "contains", value: "Office" },
      { attr: "role", op: "in", value: ["Author", "Approver", "Admin", "Case Manager"] },
    ] },
    measureIds: ["hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl"],
  },
  {
    name: "All Employees",
    description: "Baseline immunization + wellness applicable to everyone.",
    rule: { match: "ANY", conditions: [
      { attr: "site", op: "in", value: ["HQ", "Plant A", "Plant B", "Clinic"] },
    ] },
    measureIds: ["mmr", "varicella", "hepatitis_b_vaccination_series", "adult_immunization", "hypertension", "obesity_bmi"],
  },
];

/** Idempotently seed the demo segments — skips any whose name already exists. */
export async function seedSegments(store: SegmentStore): Promise<void> {
  const existing = new Set((await store.listSegments()).map((s) => s.name));
  for (const seg of DEMO_SEGMENTS) {
    if (existing.has(seg.name)) continue;
    await store.createSegment(seg);
  }
}
