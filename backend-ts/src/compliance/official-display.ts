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
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";

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
  cms137: {
    method: "Treatment initiated within 14 days of the new substance use disorder episode and engaged within 34 days of initiation.",
    whyFlagged: "Compliant: substance use disorder treatment was initiated within 14 days of the new episode and engaged (two further services, or a long-acting medication) within 34 days of initiation.",
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
  // Multi-rate (ADR-074): the bucket is the WORST of Initiation and Engagement, so OVERDUE means the
  // episode had no treatment within 14 days OR treatment began and was not engaged within 34 days.
  // The wording names both: it is what a reader gets when it has no evidence to hand (or evidence with
  // no `rates`). A reader that passes the outcome's evidence gets the missed rate's own wording from
  // OVERDUE_BY_RATE below.
  cms137: {
    method: "New substance use disorder episode without treatment initiation within 14 days, or treatment initiated but not engaged within 34 days of initiation.",
    whyFlagged: "Flagged: a new substance use disorder episode this measurement period either had no treatment initiated within 14 days, or treatment was initiated but not engaged (two further services, or a long-acting medication) within 34 days of initiation. The evidence shows which rate was missed.",
    nextAction: "Review the substance use disorder treatment plan: confirm initiation within 14 days of the episode and follow-up engagement within 34 days of initiation.",
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
  cms137: {
    method: "Excluded by measure logic (denominator exclusion or exception).",
    whyFlagged: "Excluded: denominator exclusion (hospice services) applied by official measure logic.",
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
  cms137: {
    method: "Not in the measure's initial population: no new substance use disorder episode between January 1 and November 14 of this period, or a prior episode or treatment within 60 days before it.",
    whyFlagged: "Missing data: not in the measure's initial population — no new substance use disorder episode between January 1 and November 14 of this measurement period, or a prior diagnosis or treatment within the 60 days before it.",
    nextAction: "No action required unless a new substance use disorder episode is expected on the record; rerun when complete.",
  },
};

export const OFFICIAL_DISPLAY: Record<string, Record<string, OfficialDisplay>> = {
  cms122: { COMPLIANT: COMPLIANT.cms122, OVERDUE: OVERDUE.cms122, EXCLUDED: EXCLUDED.cms122, MISSING_DATA: MISSING_DATA.cms122 },
  cms125: { COMPLIANT: COMPLIANT.cms125, OVERDUE: OVERDUE.cms125, EXCLUDED: EXCLUDED.cms125, MISSING_DATA: MISSING_DATA.cms125 },
  cms2: { COMPLIANT: COMPLIANT.cms2, OVERDUE: OVERDUE.cms2, EXCLUDED: EXCLUDED.cms2, MISSING_DATA: MISSING_DATA.cms2 },
  cms130: { COMPLIANT: COMPLIANT.cms130, OVERDUE: OVERDUE.cms130, EXCLUDED: EXCLUDED.cms130, MISSING_DATA: MISSING_DATA.cms130 },
  cms165: { COMPLIANT: COMPLIANT.cms165, OVERDUE: OVERDUE.cms165, EXCLUDED: EXCLUDED.cms165, MISSING_DATA: MISSING_DATA.cms165 },
  cms137: { COMPLIANT: COMPLIANT.cms137, OVERDUE: OVERDUE.cms137, EXCLUDED: EXCLUDED.cms137, MISSING_DATA: MISSING_DATA.cms137 },
};

/**
 * A MULTI-RATE measure's OVERDUE wording, per rate the patient missed (ADR-074, MM-1 U3). The bucket is
 * the worst of the rates, so OVERDUE alone covers clinically different situations; the persisted
 * `evidence_json.official.rates` says which one applies, and the reader passes it in. Indexed in the
 * artifact's group order — the same order `OFFICIAL_MEASURE_SEMANTICS[id].rateLabels` names.
 */
export const OVERDUE_BY_RATE: Record<string, readonly OfficialDisplay[]> = {
  cms137: [
    {
      method: "New substance use disorder episode without treatment initiation within 14 days.",
      whyFlagged: "Flagged: a new substance use disorder episode this measurement period had no treatment initiated within 14 days of the episode.",
      nextAction: "Review the substance use disorder treatment plan: treatment was not initiated within 14 days of the new episode.",
    },
    {
      method: "Treatment initiated but not engaged within 34 days of initiation.",
      whyFlagged: "Flagged: substance use disorder treatment was initiated within 14 days of the new episode but not engaged (two further services, or a long-acting medication) within 34 days of initiation.",
      nextAction: "Review follow-up engagement: treatment was initiated, and the measure requires two further services (or a long-acting medication) within 34 days of initiation.",
    },
  ],
};

type Population = { populationType?: string; result?: boolean };

/**
 * The first rate the subject is in the denominator of, not excluded or excepted from, and whose
 * numerator reads as the MISS — the rate that put them in the OVERDUE bucket. `numeratorMeansCompliant`
 * is the measure's own reading (`OFFICIAL_MEASURE_SEMANTICS`), the same one `outcomeFromPopulations`
 * applies: on a higher-is-better measure the miss is being OUT of the numerator; on an inverse measure
 * it is being IN it. -1 when the evidence carries no rates (a single-rate measure, or evidence written
 * before ADR-074) or no rate reads as missed.
 */
export function missedRateIndex(evidence: unknown, numeratorMeansCompliant: boolean): number {
  const rates = (evidence as { official?: { rates?: unknown } } | null)?.official?.rates;
  if (!Array.isArray(rates) || rates.length < 2) return -1;
  const inPopulation = (rate: Population[], key: string): boolean =>
    rate.some((p) => p?.populationType === key && p?.result === true);
  return rates.findIndex((rate) => {
    if (!Array.isArray(rate)) return false;
    const inNumerator = inPopulation(rate, "numerator");
    return (
      inPopulation(rate, "denominator") &&
      !inPopulation(rate, "denominator-exclusion") &&
      !inPopulation(rate, "denominator-exception") &&
      (numeratorMeansCompliant ? !inNumerator : inNumerator)
    );
  });
}

/**
 * Wording for one (measure, status). Pass the outcome's `evidence_json` where the caller has it: for a
 * multi-rate measure's OVERDUE it selects the missed rate's wording; for everything else it is ignored.
 */
export function officialDisplayFor(measureId: string, status: string, evidence?: unknown): OfficialDisplay | null {
  if (status === "OVERDUE" && evidence !== undefined) {
    const byRate = OVERDUE_BY_RATE[measureId];
    if (byRate) {
      const missed = missedRateIndex(evidence, officialMeasureSemantics(measureId)?.numeratorMeansCompliant ?? true);
      if (missed >= 0 && byRate[missed]) return byRate[missed];
    }
  }
  return OFFICIAL_DISPLAY[measureId]?.[status] ?? null;
}
