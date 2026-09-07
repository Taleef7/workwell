/**
 * Preparing a plain-FHIR bundle for execution by an OFFICIAL QICore artifact (roadmap §7.4, PR-8).
 *
 * ## Why this is load-bearing, with numbers
 *
 * The official artifacts retrieve against QI-Core profiles, which are materially stricter than the
 * plain FHIR our synthetic corpus emits: a diabetes `Condition` must be an ACTIVE, CONFIRMED problem
 * whose prevalence period overlaps the measurement period (QICoreCommon `ToInterval`/`isActive`), and
 * an `Encounter` is expected to carry a `class`. Our Conditions ship a system-less `clinicalStatus`
 * (they carry an onset since PR-8c/ADR-038, which the numbers below predate — it does not change them:
 * onset alone was measured at 0/25).
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
 * measure, decides denominator membership on onset timing). It was removed — and then added to the
 * CORPUS instead, which is the distinction ADR-038 turns on: the corpus invents the whole patient, so a
 * fictional diagnosis has a fictional date; this function receives data it did not create and must not
 * write one for it. `engine/ingress/enrollment/roster.ts` is the same test applied on the live path and
 * reaching the same answer.
 *
 * Closing a data gap by synthesising CODES at evaluation time would be the same violation, and is
 * likewise not done here (see `standards/cms122-official.ts`'s harness-local enrichment, which is
 * confined to the fidelity lab).
 *
 * **The consequence that gated PR-9, now CLOSED by PR-8c (ADR-038):** with preparation alone, the same
 * 25 subjects scored IPP=25 / DENOM=25 / NUMER=0 — and cms122's numerator is *poor glycemic control*,
 * so that rendered as **100% compliant**. A wrong answer that looks like good news is worse than an
 * obviously broken one, and no automatic check can distinguish it from a genuinely well-controlled
 * population. The cause recorded here originally — "the corpus lacks the real codings the official
 * numerator retrieves" — was WRONG: the corpus had dual-stamped real codes since the production-faithful
 * promotion. The real defects were a code-membership table that agreed with itself and not with VSAC,
 * a missing `us-core-sex` extension, a mammogram recorded only as a Procedure, and absent Condition
 * onsets. `wiring/corpus-membership.test.ts` and `wiring/official-corpus-outcomes.test.ts` now hold
 * that line.
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

const US_CORE_BLOOD_PRESSURE = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure";
/** The two LOINC panel codes a blood pressure is recorded under. Same set `normalize.ts` verified
 *  against the live WebChart export; kept local because these layers must be able to move apart. */
const LOINC_BP_PANEL = new Set(["85354-9", "55284-4"]);
const LOINC_SYSTOLIC = "8480-6";
const LOINC_DIASTOLIC = "8462-4";

/** LOINC by any of the spellings real bundles use — the canonical URL, a trailing slash, the OID, or
 *  (as `normalize.ts` also allows) an absent system on a code that is unambiguously LOINC. */
function isLoinc(system: unknown): boolean {
  if (typeof system !== "string") return system === undefined || system === null;
  return /loinc/i.test(system) || system === "urn:oid:2.16.840.1.113883.6.1";
}

/** The LOINC codes on one CodeableConcept — NOT flattened across a resource and its components. */
function codesOf(concept: unknown): string[] {
  const coding = (concept as { coding?: Array<{ system?: unknown; code?: unknown }> } | undefined)?.coding;
  const out: string[] = [];
  for (const c of coding ?? []) if (isLoinc(c?.system) && typeof c?.code === "string") out.push(c.code);
  return out;
}

/**
 * Whether this Observation IS a blood pressure, in the shape US Core defines one: a panel code ON THE
 * RESOURCE, and BOTH a systolic and a diastolic COMPONENT. Both halves are load-bearing, and each closes
 * a false positive review found in the first version, which flattened the resource's codes and its
 * components' codes into one list and asked whether any of them was a panel code:
 *
 * - **A vitals panel is not a blood pressure.** `[Observation 8716-3 "Vital signs"]` carrying a BP panel
 *   among its components matched, and would have been stamped — handing cms165 a resource whose other
 *   components are pulse and temperature.
 * - **Two codes on one `code` are not two components.** An Observation whose `code.coding` listed both
 *   `8480-6` and `8462-4` and had no `component` at all matched. cms165 reads systolic and diastolic
 *   OUT of `component`, so such a resource resolves to null — and being the newest, it would displace a
 *   real controlled reading and flip a compliant patient.
 * - **An empty panel is not a reading.** A panel header with no components — a cancelled order, a
 *   `dataAbsentReason` — matched on its code alone, with the same displacing effect.
 *
 * Requiring both halves means this UNDER-stamps rather than over-stamps, which is the right direction:
 * a missed stamp leaves a measure unable to see a reading, and a wrong one puts a resource that is not a
 * blood pressure into a compliance population.
 *
 * **The stamp never leaves the copy.** Both production callers use `preparedForQiCore`, which clones
 * first (`official-executor-adapter.ts`, `standards/literal-diff.ts`), and nothing persists or exports
 * the prepared bundle — `evidence_json` stores population results, not resources. So this cannot put a
 * profile claim into a QRDA document, a MeasureReport, or anything a third party reads, and the
 * authored engine sees the same bytes it always did (ADR-008). Two reviewers asked; it is written down
 * so the third does not have to.
 */
function isBloodPressure(resource: Record<string, unknown>): boolean {
  if (!codesOf(resource.code).some((c) => LOINC_BP_PANEL.has(c))) return false;
  const components = (resource.component as Array<{ code?: unknown; valueQuantity?: unknown }> | undefined) ?? [];
  const measured = (loinc: string) =>
    components.filter((c) => codesOf(c?.code).includes(loinc) && c?.valueQuantity != null);
  // EXACTLY one of each, each carrying a value. Not "at least one": cms165 reads the systolic out with
  // `singleton from`, which THROWS on two — a bilateral reading or a duplicated flowsheet row — and a
  // throw mid-run is the failure the per-measure profile work exists to prevent. And a component with
  // no `valueQuantity` is not a measurement, so stamping it would assert a US Core conformance the
  // resource does not have, which is this file's fabrication line (review finding).
  return measured(LOINC_SYSTOLIC).length === 1 && measured(LOINC_DIASTOLIC).length === 1;
}

/** Add a profile to `meta.profile` without disturbing any already there. */
function stampProfile(resource: Record<string, unknown>, profile: string): void {
  const meta = (resource.meta ??= {}) as { profile?: unknown };
  // A malformed scalar `meta.profile` is KEPT and appended to, never dropped: this function's job is to
  // add a profile, and silently discarding whatever a source already asserted is a different act
  // (review finding).
  const existing = Array.isArray(meta.profile)
    ? (meta.profile as string[])
    : typeof meta.profile === "string"
      ? [meta.profile]
      : [];
  if (!existing.includes(profile)) meta.profile = [...existing, profile];
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
    } else if (resource.resourceType === "Observation" && isBloodPressure(resource)) {
      // CMS165 identifies a blood pressure by PROFILE ALONE — it is the only Observation retrieve in
      // that artifact with no code filter — so it is the one measure the executor runs with
      // `trustMetaProfile: true` (ADR-076 d1). Under that setting an unstamped reading is not
      // retrieved at all, which is why the ADR-075 corpus stamps its own and why any bundle source
      // that does not needs this (issue #533).
      //
      // **This is one necessary piece and nowhere near sufficient**, which the first version of this
      // comment got wrong in kind rather than in degree (review finding, verified in the library).
      // `trustMetaProfile: true` reaches `cql-exec-fhir`'s `requireProfileTagging`, and that filters
      // EVERY profile-typed retrieve on `meta.profile` — not only the blood-pressure one — while the
      // Patient retrieve additionally THROWS when nothing matches
      // (`cql-exec-fhir/lib/fhir.js:428,442`). cms165 is authored on QI-Core 6, so it wants
      // `qicore-patient`, `qicore-encounter`, both Condition profiles and more; the ADR-075 corpus
      // stamps fourteen, which is why cms165 runs there and only there.
      //
      // So on a bundle that carries no profiles, this stamp does not make cms165 work — the Patient
      // retrieve throws first, loudly, before any blood pressure is examined. What it does is make a
      // blood pressure IDENTIFIABLE, which is the piece no other layer can supply, since only the codes
      // say what the resource is. The rest of #533's ingest half is still open, and a second blocker
      // sits behind it: teatea exports the BP panel with `status: "unknown"` (verified 2026-07-23, see
      // `engine/ingress/webchart/normalize.ts`) while `Status.isObservationBP` admits only
      // `final | amended | corrected`.
      //
      // This is NORMALIZATION and not fabrication, by this file's own test: the profile is DERIVED
      // from codes the resource already carries — the LOINC BP panel, or both a systolic and a
      // diastolic component — and no clinical fact is added. A resource that does not already say it
      // is a blood pressure is left alone, so nothing can be promoted INTO the measure by this. It is
      // the same move as the Condition status above: filling in the structural metadata the official
      // profiles require, from what the data already asserts.
      stampProfile(resource, US_CORE_BLOOD_PRESSURE);
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
