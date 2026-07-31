/**
 * What an official measure's NUMERATOR means in WorkWell's workflow vocabulary (roadmap §7.3).
 *
 * ## Why this is a hand-maintained table and not derived
 *
 * The obvious derivation is `Measure.improvementNotation`, and it is wrong. CMS122's published artifact
 * declares `increase` even though the measure is inverse — its numerator is *poor glycemic control*
 * (HbA1c > 9% or not assessed), so a HIGHER rate is WORSE. PR-5 recorded that discrepancy in the manifest
 * rather than silently correcting it, precisely so it could not be laundered into a derivation here.
 * Reading it would flip every CMS122 subject's status.
 *
 * So the mapping is an explicit, human-reviewed assertion per measure, with the reasoning written down.
 * It is **fail-closed**: a measure with no entry cannot be routed to official execution, because the
 * alternative is guessing, and guessing wrong inverts a compliance report.
 *
 * ## What this does NOT do
 *
 * It never touches the regulatory truth. `evidence_json.official.populationResults` persists the
 * membership fqm reported, verbatim, and that is what MeasureReport/QRDA read (ADR-031, PR-3). This table
 * only decides which of the five workflow buckets an operator sees in the roster and worklist — the
 * vocabulary that answers "does someone need to chase this person", which is a different question from
 * "what does the measure report".
 */

/** WorkWell's reading of one official measure's populations. */
export interface OfficialMeasureSemantics {
  /**
   * True when being IN the numerator is the good outcome (a screening was done), false when it is the
   * bad one (an inverse measure, where the numerator counts failures).
   */
  numeratorMeansCompliant: boolean;
  /** Why, in the measure's own terms. Reviewed by a human; cite the numerator's clinical meaning. */
  rationale: string;
}

export const OFFICIAL_MEASURE_SEMANTICS: Readonly<Record<string, OfficialMeasureSemantics>> = {
  cms122: {
    numeratorMeansCompliant: false,
    rationale:
      "Numerator = most recent HbA1c > 9% OR no glycemic assessment during the period. Being in it is " +
      "the failure. The artifact's improvementNotation says 'increase', which contradicts eCQI's own " +
      "description of the measure; the artifact is not followed here.",
  },
  cms2: {
    numeratorMeansCompliant: true,
    rationale:
      "Numerator = screened for depression with an age-appropriate standardized tool on or within 14 " +
      "days before the encounter AND, if positive, a follow-up plan documented on the date of the " +
      "positive screen. Being in it is the care being delivered.",
  },
  cms68: {
    numeratorMeansCompliant: true,
    rationale:
      "Numerator = the eligible clinician attested to documenting the patient's current medications " +
      "using all immediate resources available on the encounter date. Being in it is the documentation " +
      "having happened.",
  },
  cms951: {
    numeratorMeansCompliant: true,
    rationale:
      "Numerator = received a kidney health evaluation during the measurement period (an eGFR AND a " +
      "uACR, or an eGFR with urine albumin and urine creatinine). Being in it is the evaluation having " +
      "been done.",
  },
  cms125: {
    numeratorMeansCompliant: true,
    rationale:
      "Numerator = a mammogram in the qualifying window. Being in it is the compliant outcome, and the " +
      "artifact's improvementNotation ('increase') agrees.",
  },
};

/**
 * The semantics for a measure, or `undefined` when none is recorded.
 *
 * Callers MUST treat `undefined` as "cannot route this measure officially" rather than falling back to a
 * default. There is no safe default: assuming `true` reports every poorly-controlled diabetic as
 * compliant, and assuming `false` reports every screened woman as overdue.
 */
export function officialMeasureSemantics(catalogId: string): OfficialMeasureSemantics | undefined {
  // `Object.hasOwn`, not a bare index: PR-7b calls this with an OPERATOR-supplied id, and a plain object
  // literal resolves inherited keys — `officialMeasureSemantics("constructor")` would otherwise return a
  // truthy non-semantics value whose `numeratorMeansCompliant` is `undefined`, i.e. everyone OVERDUE.
  return Object.hasOwn(OFFICIAL_MEASURE_SEMANTICS, catalogId)
    ? OFFICIAL_MEASURE_SEMANTICS[catalogId]
    : undefined;
}
