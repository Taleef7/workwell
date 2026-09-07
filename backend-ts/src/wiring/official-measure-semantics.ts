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
  /**
   * A MULTI-RATE measure's rate names, in the artifact's `Measure.group` order (ADR-074). They label
   * each rate's populations in the persisted `expressionResults` and index the per-rate display
   * wording; absent for a single-rate measure. Reviewed with the measure, like the field above.
   */
  rateLabels?: readonly string[];
  /**
   * Retrieve by QI-Core PROFILE as well as resource type, for this measure only. Default false, which
   * is what every other measure gets and what the executor's docstring explains at length: trusting
   * profiles globally empties the population for cms122 and cms125, which are routed today.
   *
   * cms165 is the one pilot measure that cannot be scored correctly without it.
   * `[Observation: us-core-blood-pressure]` is its only Observation retrieve with NO code filter — the
   * other four (hospice, palliative care, frailty, advanced illness) each name a code or a value set —
   * so it identifies a blood pressure by profile ALONE, and `Status.isObservationBP` narrows only by
   * `status`. With profiles ignored, every final Observation is a candidate blood pressure: whichever
   * of a patient's results is most recent is read as their latest reading, and a hemoglobin has no
   * systolic component. The old synthetic fixture emitted one Observation per subject, the only shape
   * that hides it.
   *
   * Turning it on is available because the ADR-075 corpus stamps the profile each retrieve names —
   * `corpus-bundle.ts` says it does so precisely to make this possible. It is a per-measure switch and
   * not a global one for the same reason it defaults false.
   *
   * **This does not by itself make cms165 routable.** A bundle whose resources are NOT profile-stamped
   * retrieves nothing under it, so a WebChart-derived roster needs its blood pressures stamped at
   * ingest first. That failure is at least LOUD — the executor's batch-level refusal fires when nothing
   * retrieves across a roster — where the current one is silent and wrong.
   */
  trustMetaProfile?: boolean;
}

export const OFFICIAL_MEASURE_SEMANTICS: Readonly<Record<string, OfficialMeasureSemantics>> = {
  cms137: {
    numeratorMeansCompliant: true,
    rationale:
      "MIPS 305. Rate 1 numerator = treatment initiated within 14 days of a new SUD episode; rate 2 = " +
      "two or more further services within 34 days of initiating. Both are things that SHOULD happen, " +
      "and the artifact declares improvementNotation=increase, so being in a numerator is compliance. " +
      "MULTI-RATE: a subject is COMPLIANT only when every rate they are in the denominator for is met " +
      "- an initiated-but-not-engaged patient still has an open care gap, and a worklist calling them " +
      "compliant would hide exactly the follow-up this measure exists to prompt (ADR-074).",
    rateLabels: ["Initiation", "Engagement"],
  },
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
  // Verified against the manifest.json and vendored Measure resource in measures/official/cms130.
  cms130: {
    numeratorMeansCompliant: true,
    rationale:
      "Numerator = one or more colorectal cancer screenings in the measure's defined windows. Being in " +
      "it is the screening having happened, and the artifact's improvementNotation ('increase') agrees.",
  },
  // Verified against the manifest.json and vendored Measure resource in measures/official/cms165.
  cms165: {
    numeratorMeansCompliant: true,
    rationale:
      "Numerator = the most recent blood pressure is adequately controlled (systolic < 140 mmHg and " +
      "diastolic < 90 mmHg) during the measurement period. Being in it is the blood pressure being " +
      "controlled, and the artifact's improvementNotation ('increase') agrees.",
    // The only measure that retrieves a blood pressure by profile alone — see the field's own note.
    trustMetaProfile: true,
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
