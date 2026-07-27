/**
 * Preparing a plain-FHIR bundle for execution by an OFFICIAL QICore artifact (roadmap §7.4, PR-8).
 *
 * ## Why this is load-bearing, with numbers
 *
 * The official artifacts retrieve against QI-Core profiles, which are materially stricter than the
 * plain FHIR our synthetic corpus emits: a diabetes `Condition` must be an ACTIVE, CONFIRMED problem
 * whose prevalence period overlaps the measurement period (QICoreCommon `ToInterval`/`isActive`), and
 * an `Encounter` is expected to carry a `class`. Our Conditions ship a system-less `clinicalStatus`
 * and no `onsetDateTime`.
 *
 * Measured against the vendored CMS122 artifact over 25 synthetic subjects (2026-07-27):
 *
 * | bundle                | IPP | DENOM | NUMER |
 * |-----------------------|-----|-------|-------|
 * | raw synthetic         |   0 |     0 |     0 |
 * | + `prepareForQiCore`  |  25 |    25 |     0 |
 *
 * Without this, **every subject reads out-of-population** — a run that completes successfully and
 * reports the entire roster as MISSING_DATA. That is why it moved out of `standards/literal-diff.ts`,
 * where it was private to the fidelity lab while the router's docstring recorded needing it as a PR-8
 * obligation. One implementation, used by the diff and by the runtime executor, is the only way those
 * two can be compared at all.
 *
 * ## What this is NOT
 *
 * It is **normalization, never fabrication**: it fills in FHIR structural metadata the official
 * profiles require, and touches no clinical fact — no code, no value, no date of an actual event. The
 * synthetic corpus separately lacks the real LOINC/SNOMED codings the official numerator retrieves
 * (see `standards/cms122-official.ts`'s harness-local enrichment, and the caveat below), and closing
 * THAT gap by synthesising codes at evaluation time would be fabricating clinical data. It is not done
 * here and must not be.
 *
 * **The measured consequence, recorded because it gates PR-9:** with preparation alone, the same 25
 * subjects score IPP=25 / DENOM=25 / NUMER=0 — and cms122's numerator is *poor glycemic control*, so
 * that renders as **100% compliant**. A wrong answer that looks like good news is worse than an
 * obviously broken one, and no automatic check can distinguish it from a genuinely well-controlled
 * population. The shadow period (PR-8) is what catches it, and the real fix is a synthetic corpus that
 * emits real codes — which the roadmap already schedules per measure at PR-10..12.
 *
 * Real WebChart data carries real codes and US Core 7 structure (= QI-Core STU7), so it needs the
 * enrichment not at all and this preparation probably only partially. Which parts remain necessary
 * there is an M-D question, answerable only against live data.
 */

/** The minimum bundle shape this operates on — deliberately structural, not the app's FHIR types. */
export interface PreparableBundle {
  resourceType: "Bundle";
  type?: string;
  entry: Array<{ resource: Record<string, unknown> }>;
}

const CLINICAL_ACTIVE = {
  coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }],
};
const VERIFICATION_CONFIRMED = {
  coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
};
const PROBLEM_CATEGORY = {
  coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "problem-list-item" }],
};
const AMBULATORY_CLASS = { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" };

/**
 * Normalize a bundle IN PLACE so an official QICore artifact's retrieves can see it.
 *
 * `asOf` is the evaluation date; a missing onset is anchored three years before it, comfortably outside
 * the `[year-01-01, year-12-31]` measurement period, so a condition reads as pre-existing rather than
 * as newly diagnosed inside the period.
 *
 * `clinicalStatus`/`verificationStatus` are OVERWRITTEN rather than merged: the synthetic coding is
 * system-less and cannot match QI-Core's `ConditionClinicalStatusCodes` binding, so a merge would leave
 * an unmatched coding beside a matched one and change nothing. `category`, `onset` and Encounter
 * `class` are filled only when ABSENT, so real data that already carries them is never overwritten —
 * which is what makes this safe to run over a WebChart bundle as well as a synthetic one.
 */
export function prepareForQiCore(bundle: PreparableBundle, asOf: string): void {
  const onset = `${Number(asOf.slice(0, 4)) - 3}-01-01`;
  for (const entry of bundle.entry ?? []) {
    const resource = entry?.resource;
    if (!resource) continue;
    if (resource.resourceType === "Condition") {
      resource.clinicalStatus = CLINICAL_ACTIVE;
      resource.verificationStatus = VERIFICATION_CONFIRMED;
      if (!resource.category) resource.category = [PROBLEM_CATEGORY];
      if (!resource.onsetDateTime && !resource.onsetPeriod) resource.onsetDateTime = onset;
    } else if (resource.resourceType === "Encounter") {
      if (!resource.class) resource.class = AMBULATORY_CLASS;
    }
  }
}

/**
 * As `prepareForQiCore`, but on a structural copy — for callers that must not mutate the bundle they
 * were handed. The runtime executor is one: it receives a bundle the authored engine may also evaluate,
 * and ADR-008 requires the authored outcome to be byte-identical whether or not official routing is on.
 */
export function preparedForQiCore<T extends PreparableBundle>(bundle: T, asOf: string): T {
  const copy = structuredClone(bundle);
  prepareForQiCore(copy, asOf);
  return copy;
}
