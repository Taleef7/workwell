/**
 * Demo risk-group seed (#183 E11.3). Idempotent by segment name: existing names are left untouched,
 * so re-running on boot is safe and operator edits are never clobbered. Seeds three ENABLED cohorts
 * whose rule-sets together cover EVERY Active runnable measure (no measure is orphaned) while giving the
 * roster grid a meaningful applicable/N-A mix:
 *   - All Employees      — the universal occupational-health baseline (wellness + preventive eCQM + Td/Tdap)
 *   - OSHA Safety-Sensitive — field roles add the OSHA surveillance program
 *   - Clinical Staff     — clinic/nursing roles add infection control + the healthcare-worker immunity series
 * `no-orphaned-measure-in-demo-seed` (segment-seed.test.ts) guards the coverage invariant.
 */
import type { CreateSegmentInput, SegmentStore } from "../stores/segment-store.ts";

export const DEMO_SEGMENTS: CreateSegmentInput[] = [
  {
    // Everyone: chronic-disease + preventive screening (incl. the two CMS eCQMs) and the routine
    // adult Td/Tdap booster. CQL still decides per-subject eligibility WITHIN each measure.
    name: "All Employees",
    description: "Universal occupational-health baseline — wellness screening, preventive eCQMs, and the adult Td/Tdap booster, applicable to everyone.",
    rule: { match: "ANY", conditions: [{ attr: "site", op: "in", value: ["HQ", "Plant A", "Plant B", "Clinic"] }] },
    measureIds: [
      "hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "cms125", "cms122", "adult_immunization",
    ],
  },
  {
    name: "OSHA Safety-Sensitive",
    description: "Field roles in OSHA surveillance programs — adds audiometry, HAZWOPER, and TB screening.",
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
    description: "Clinic-based and nursing staff — adds influenza, TB screening, and the MMR/Varicella/Hep B immunity series.",
    rule: { match: "ANY", conditions: [
      { attr: "site", op: "equals", value: "Clinic" },
      { attr: "role", op: "contains", value: "Nurse" },
    ] },
    measureIds: ["flu_vaccine", "tb_surveillance", "mmr", "varicella", "hepatitis_b_vaccination_series"],
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
