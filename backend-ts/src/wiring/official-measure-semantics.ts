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
   * The QI-Core/US Core profiles this measure retrieves BY PROFILE; every other retrieve is by resource
   * type, as for every measure without this field. The executor keeps, for a retrieve of one of these,
   * only the resources whose `meta.profile` names it (`profileNarrowedPatientSource`). Absent for every
   * measure but cms165.
   *
   * cms165 cannot be scored correctly without it. `[Observation: us-core-blood-pressure]` is its only
   * profile-typed retrieve with NO code filter (pinned by `official-cms165-retrieves.test.ts`), so it
   * identifies a blood pressure by profile ALONE, and `Status.isObservationBP` narrows only by `status`.
   * Read by type, every final Observation is a candidate blood pressure: whichever of a patient's results
   * is most recent is read as their latest reading, and a hemoglobin has no systolic component.
   *
   * Only that one profile, not all of them (#591). Until 2026-10-10 cms165 trusted EVERY profile
   * (fqm's `trustMetaProfile`), which needed the exact QI-Core profile on each patient, encounter,
   * condition and procedure; the corpus stamps them, nothing else does, and the Patient retrieve throws
   * without its one, so every QRDA-imported patient errored. Measured against that mode: identical on
   * CMS's 68 MADiE cases and on all 20,000 corpus patients; trusting none differs on 624 of a 2,500 sample.
   * Trusting every profile globally would also empty cms122's and cms125's populations, which retrieve
   * profiles our data does not carry.
   */
  trustedProfiles?: readonly string[];
}

/** The US Core blood-pressure profile, the one cms165 retrieves with no code filter. */
export const US_CORE_BLOOD_PRESSURE = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure";

/** The profile trust to hand the executor for a measure: by type, except the measure's trusted profiles. */
export function trustedProfilesOf(semantics: OfficialMeasureSemantics | undefined): readonly string[] {
  return semantics?.trustedProfiles ?? [];
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
    trustedProfiles: [US_CORE_BLOOD_PRESSURE],
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
