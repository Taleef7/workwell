/**
 * What a patient-facing message calls a gap: a plain phrase ("a mammogram"), never the measure's catalog
 * title or a CMS/MIPS id (production readiness Q1). A title such as "Diabetes: Glycemic Status Assessment
 * Greater Than 9%" tells a patient nothing they can act on, and some titles disclose a diagnosis.
 *
 * Two measures are never named to a patient: CMS2 (depression screening and follow-up) and CMS137
 * (substance use disorder treatment), whose very name discloses a condition. A message about one says only
 * "a visit with your care team", and a campaign never sends for them: contacting those patients is a staff
 * decision made case by case.
 *
 * Patient-facing wording: a practice clinician signs it off before the real-data phase (plan CS2).
 */
export const SENSITIVE_MEASURES: ReadonlySet<string> = new Set(["cms2", "cms137"]);

/** A measure id as the tables here key it: lower case, without a CMS version suffix (`CMS137v14` -> `cms137`). */
function measureKey(measureId: string): string {
  const id = measureId.trim().toLowerCase();
  return /^cms\d+v\d+$/.test(id) ? id.replace(/v\d+$/, "") : id;
}

/** Whether a gap's measure may never be named to a patient or sent by campaign (CMS2, CMS137, any version). */
export function isSensitiveMeasure(measureId: string): boolean {
  return SENSITIVE_MEASURES.has(measureKey(measureId));
}

export const NEUTRAL_CARE_ITEM = "a visit with your care team";

const CARE_ITEMS: Readonly<Record<string, string>> = {
  cms125: "a mammogram",
  cms130: "a colorectal cancer screening",
  cms122: "an A1c blood test",
  cms165: "a blood pressure check",
};

export function careItemFor(measureId: string): string {
  const key = measureKey(measureId);
  return Object.hasOwn(CARE_ITEMS, key) ? CARE_ITEMS[key]! : NEUTRAL_CARE_ITEM;
}

/** "a mammogram", "a mammogram and an A1c blood test", "a, b and c" — each phrase once, in first-seen order. */
export function joinCareItems(measureIds: readonly string[]): string {
  const items = [...new Set(measureIds.map(careItemFor))];
  if (items.length <= 1) return items[0] ?? NEUTRAL_CARE_ITEM;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
