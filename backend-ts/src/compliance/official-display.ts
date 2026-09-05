/**
 * Official display table (Task 8): per-measure, per-status wording for measures evaluated by the
 * official published artifact (the `WORKWELL_OFFICIAL_MEASURES` allowlist). Authored-measure wording
 * describes a periodic exam; official CQL decides population membership, so OVERDUE for cms122 means
 * "most recent glycemic status above 9%", not "no record on file". `CQL alone decides the status; this
 * table is prose for humans. Display wording is never a rule the engine honours.
 *
 * Wording is consumed at READ time (`deriveCell`, `nextActionFor`, `deriveWhyFlagged`) and never
 * persisted as a rule (DATA_MODEL_CONTRACTS §5) — evidence_json is unchanged by this module.
 */
export type OfficialDisplay = {
  method: string;
  whyFlagged: string;
  nextAction: string;
};

const COMPLIANT = {
  cms122: {
    method: "Most recent glycemic status assessment (HbA1c or GMI) at or below 9%.",
    whyFlagged: "Compliant: most recent glycemic status assessment (HbA1c or GMI) is at or below 9% for this measurement period.",
    nextAction: "No action required.",
  },
  cms125: {
    method: "Mammogram within the accepted interval.",
    whyFlagged: "Compliant: a mammogram within the accepted interval is on file for this measurement period.",
    nextAction: "No action required.",
  },
  cms2: {
    method: "Depression screening with follow-up plan when positive.",
    whyFlagged: "Compliant: depression screening is documented for this period and a positive screen has a follow-up plan.",
    nextAction: "No action required.",
  },
  cms130: {
    method: "Colorectal cancer screening within the accepted interval.",
    whyFlagged: "Compliant: colorectal cancer screening within the accepted interval is on file for this measurement period.",
    nextAction: "No action required.",
  },
  cms165: {
    method: "Most recent blood pressure below 140/90.",
    whyFlagged: "Compliant: most recent blood pressure this measurement period is below 140/90.",
    nextAction: "No action required.",
  },
};

const OVERDUE = {
  cms122: {
    method: "Most recent glycemic status assessment (HbA1c or GMI) above 9%.",
    whyFlagged: "Flagged: the most recent glycemic status assessment (HbA1c or GMI) for this measurement period is above 9%. This is a result, not a missing record.",
    nextAction: "Review glycemic control.",
  },
  cms125: {
    method: "No mammogram in the 27-month window.",
    whyFlagged: "Flagged: no mammogram within the 27-month window for this measurement period.",
    nextAction: "Review breast imaging history; order or document screening if none exists.",
  },
  cms2: {
    method: "No depression screening this period, or a positive screen without a follow-up plan.",
    whyFlagged: "Flagged: no depression screening this period, or a positive screen without a follow-up plan.",
    nextAction: "Review screening history and follow-up plan; complete the gap in the record.",
  },
  cms130: {
    method: "No colorectal cancer screening within the accepted interval.",
    whyFlagged: "Flagged: no colorectal cancer screening within the accepted interval for this measurement period.",
    nextAction: "Review screening history; order or document screening if none exists.",
  },
  cms165: {
    method: "Most recent blood pressure this period at or above 140/90.",
    whyFlagged: "Flagged: most recent blood pressure this measurement period is at or above 140/90.",
    nextAction: "Review blood pressure management.",
  },
};

const EXCLUDED = {
  cms122: {
    method: "Excluded by measure logic (denominator exclusion or exception).",
    whyFlagged: "Excluded: denominator exclusion or exception applied by official measure logic.",
    nextAction: "No action required.",
  },
  cms125: {
    method: "Excluded by measure logic (denominator exclusion or exception).",
    whyFlagged: "Excluded: denominator exclusion or exception applied by official measure logic.",
    nextAction: "No action required.",
  },
  cms2: {
    method: "Excluded by measure logic (denominator exclusion or exception).",
    whyFlagged: "Excluded: denominator exclusion or exception applied by official measure logic.",
    nextAction: "No action required.",
  },
  cms130: {
    method: "Excluded by measure logic (denominator exclusion or exception).",
    whyFlagged: "Excluded: denominator exclusion or exception applied by official measure logic.",
    nextAction: "No action required.",
  },
  cms165: {
    method: "Excluded by measure logic (denominator exclusion or exception).",
    whyFlagged: "Excluded: denominator exclusion or exception applied by official measure logic.",
    nextAction: "No action required.",
  },
};

const MISSING_DATA = {
  cms122: {
    method: "Not in the measure's initial population for this period, or no qualifying encounter.",
    whyFlagged: "Missing data: not in the measure's initial population for this period, or no qualifying encounter.",
    nextAction: "Check eligibility and encounter data; rerun when complete.",
  },
  cms125: {
    method: "Not in the measure's initial population for this period, or no qualifying encounter.",
    whyFlagged: "Missing data: not in the measure's initial population for this period, or no qualifying encounter.",
    nextAction: "Check eligibility and encounter data; rerun when complete.",
  },
  cms2: {
    method: "Not in the measure's initial population for this period, or no qualifying encounter.",
    whyFlagged: "Missing data: not in the measure's initial population for this period, or no qualifying encounter.",
    nextAction: "Check eligibility and encounter data; rerun when complete.",
  },
  cms130: {
    method: "Not in the measure's initial population for this period, or no qualifying encounter.",
    whyFlagged: "Missing data: not in the measure's initial population for this period, or no qualifying encounter.",
    nextAction: "Check eligibility and encounter data; rerun when complete.",
  },
  cms165: {
    method: "Not in the measure's initial population for this period, or no qualifying encounter.",
    whyFlagged: "Missing data: not in the measure's initial population for this period, or no qualifying encounter.",
    nextAction: "Check eligibility and encounter data; rerun when complete.",
  },
};

export const OFFICIAL_DISPLAY: Record<string, Record<string, OfficialDisplay>> = {
  cms122: { COMPLIANT: COMPLIANT.cms122, OVERDUE: OVERDUE.cms122, EXCLUDED: EXCLUDED.cms122, MISSING_DATA: MISSING_DATA.cms122 },
  cms125: { COMPLIANT: COMPLIANT.cms125, OVERDUE: OVERDUE.cms125, EXCLUDED: EXCLUDED.cms125, MISSING_DATA: MISSING_DATA.cms125 },
  cms2: { COMPLIANT: COMPLIANT.cms2, OVERDUE: OVERDUE.cms2, EXCLUDED: EXCLUDED.cms2, MISSING_DATA: MISSING_DATA.cms2 },
  cms130: { COMPLIANT: COMPLIANT.cms130, OVERDUE: OVERDUE.cms130, EXCLUDED: EXCLUDED.cms130, MISSING_DATA: MISSING_DATA.cms130 },
  cms165: { COMPLIANT: COMPLIANT.cms165, OVERDUE: OVERDUE.cms165, EXCLUDED: EXCLUDED.cms165, MISSING_DATA: MISSING_DATA.cms165 },
};

export function officialDisplayFor(measureId: string, status: string): OfficialDisplay | null {
  return OFFICIAL_DISPLAY[measureId]?.[status] ?? null;
}
