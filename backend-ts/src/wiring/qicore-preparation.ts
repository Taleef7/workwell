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
 * | bundle                        | IPP | DENOM | NUMER |
 * |-------------------------------|-----|-------|-------|
 * | raw synthetic                 |   0 |     0 |     0 |
 * | + `prepareForQiCore`          |  25 |    25 |     0 |
 *
 * Isolating the parts (same 25 subjects) showed the whole effect is the CONDITION STATUS: status alone
 * is 25/25, adding category and Encounter class changes nothing, and an invented onset alone is 0/25.
 * That measurement is why onset anchoring was removed rather than kept "just in case" — see below.
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
 * profiles require, and touches no clinical fact — no code, no value, no date of an actual event. That
 * rule cost something to keep: the first cut anchored a missing onset three years before the evaluation
 * date, which review correctly called out as fabricating exactly such a date (and CMS165, a priority
 * measure, decides denominator membership on onset timing). It was removed. The
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

const clinicalActive = () => ({
  coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }],
});
const verificationConfirmed = () => ({
  coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
});
const problemCategory = () => [
  { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "problem-list-item" }] },
];
const ambulatoryClass = () => ({ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" });

/** True when a CodeableConcept carries no coding that names a system — i.e. nothing that can bind. */
function unbindable(concept: unknown): boolean {
  const codings = (concept as { coding?: Array<{ system?: unknown }> } | undefined)?.coding;
  if (!Array.isArray(codings) || codings.length === 0) return true;
  return !codings.some((coding) => typeof coding?.system === "string" && coding.system.length > 0);
}

/**
 * Normalize a bundle IN PLACE so an official QICore artifact's retrieves can see it.
 *
 * Every write here is conditional on the field being ABSENT OR UNBINDABLE, so data that already carries
 * a real value is never rewritten. That is the whole basis for running this over a WebChart bundle and
 * not only over the synthetic corpus.
 *
 * **`clinicalStatus`/`verificationStatus` are replaced only when nothing in them names a system.** The
 * first version overwrote unconditionally, reasoning that the synthetic coding is system-less so a merge
 * would change nothing — true of the synthetic corpus, and false as a rule: it would have turned a
 * `resolved`, `refuted` or `entered-in-error` Condition into an active, confirmed one. A patient whose
 * misdiagnosis was corrected would enter CMS122's denominator and, having no HbA1c, its numerator.
 * The defect being fixed is an unbindable coding, so that is what the condition tests.
 *
 * **Onset is NOT invented**, which is why this takes no evaluation date at all. An earlier cut
 * anchored a missing onset three years before the evaluation date, which
 * this module's own rule forbids: an onset date is the date of an actual event, and CMS165 — on the
 * priority list — gates its denominator on hypertension onset relative to the measurement period, so a
 * fabricated one would decide membership. Measured over 25 synthetic subjects against the CMS122
 * artifact, it also bought nothing: status alone yields IPP=25/25, identical to applying every part,
 * while onset alone yields 0/25. Both reasons point the same way. If a future measure genuinely cannot
 * retrieve without an onset, the answer is a corpus that records one, not a value minted here.
 */
export function prepareForQiCore(bundle: PreparableBundle): void {
  for (const entry of bundle.entry ?? []) {
    const resource = entry?.resource;
    if (!resource) continue;
    if (resource.resourceType === "Condition") {
      // Fresh objects per resource: a shared constant assigned by reference would alias one object into
      // every prepared bundle, so a single downstream mutation would reach all of them at once.
      if (unbindable(resource.clinicalStatus)) resource.clinicalStatus = clinicalActive();
      if (unbindable(resource.verificationStatus)) resource.verificationStatus = verificationConfirmed();
      if (!resource.category) resource.category = problemCategory();
    } else if (resource.resourceType === "Encounter") {
      if (!resource.class) resource.class = ambulatoryClass();
    }
  }
}

/**
 * As `prepareForQiCore`, but on a structural copy — for callers that must not mutate the bundle they
 * were handed. The runtime executor is one: it receives a bundle the authored engine may also evaluate,
 * and ADR-008 requires the authored outcome to be byte-identical whether or not official routing is on.
 */
export function preparedForQiCore<T extends PreparableBundle>(bundle: T): T {
  const copy = structuredClone(bundle);
  prepareForQiCore(copy);
  return copy;
}
