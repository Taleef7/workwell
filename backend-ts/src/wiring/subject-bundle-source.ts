/**
 * The seam between "who is evaluated, at which seeded bucket" and "what FHIR bundle they carry" (spec §4).
 * The run pipeline calls this and never reaches into MEASURE_BINDINGS for a bundle. `target` is the
 * seeded distribution BUCKET (exam-config.ts) — never a decision; CQL decides every outcome.
 */
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig, type TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle, type FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { buildOfficialOnlyBundle, type OfficialOnlyMeasureId } from "../engine/synthetic/official-only-bundles.ts";
import { seededDistribution, seededTargetFor, type SeededAssignment } from "../run/distribution.ts";
import { classifyRunnable, DEPLOYMENT_PROFILE } from "../config/deployment-profile.ts";
import { corpusBundleSource } from "./corpus-bundle-source.ts";

export interface SubjectBundleSource {
  targetFor(employees: readonly EmployeeProfile[], measureId: string, subjectId: string): TargetOutcome | null;
  distribution(employees: readonly EmployeeProfile[], measureId: string): SeededAssignment[];
  bundleFor(employee: EmployeeProfile, measureId: string, target: TargetOutcome, evaluationDate: string): FhirBundle;
  /**
   * The subject's WHOLE record, measure-independent. The pipeline prefers this when a source provides
   * it and builds it ONCE PER CHUNK — a full-record bundle rebuilt per measure is 5x redundant at the
   * pilot's measure count (spec §4). A source whose bundles genuinely differ per measure omits it.
   */
  bundleForSubject?(employee: EmployeeProfile, evaluationDate: string): FhirBundle;
}

export function bindingBundleSource(): SubjectBundleSource {
  const rateKey = (id: string) => MEASURE_BINDINGS[id]!.rateKey;
  return {
    targetFor: (employees, id, subjectId) => seededTargetFor(employees, rateKey(id), subjectId),
    distribution: (employees, id) => seededDistribution(employees, rateKey(id)),
    bundleFor: (employee, id, target, evaluationDate) => buildSyntheticBundle(employee, deriveExamConfig(MEASURE_BINDINGS[id]!, target), evaluationDate),
  };
}

/** Task 3: the official-only measures (cms2/cms130/cms165) get QI-Core shapes written directly
 *  against the official artifacts' ELM — see `engine/synthetic/official-only-bundles.ts`. */
export function officialOnlyBundleSource(): SubjectBundleSource {
  return {
    targetFor: (employees, id, subjectId) => seededTargetFor(employees, id, subjectId),
    distribution: (employees, id) => seededDistribution(employees, id),
    bundleFor: (employee, id, target, evaluationDate) =>
      buildOfficialOnlyBundle(employee, id as OfficialOnlyMeasureId, target, evaluationDate),
  };
}

/** Dispatches on the runnable rule; throws for anything that is not runnable rather than guessing. */
export function compositeBundleSource(
  env: Record<string, unknown>,
  sources: { authored?: SubjectBundleSource; official?: SubjectBundleSource; corpus?: SubjectBundleSource } = {},
): SubjectBundleSource {
  const authored = sources.authored ?? bindingBundleSource();
  const official = sources.official ?? officialOnlyBundleSource();
  const pick = (id: string): SubjectBundleSource => {
    const kind = classifyRunnable(id, env);
    if (kind.kind === "official") {
      // cms122/cms125 are official-routed but keep their dual-stamped binding-built bundles today;
      // the official-only ids (cms2/cms130/cms165) fall through to the official-only shapes.
      if (MEASURE_BINDINGS[id]) return authored;
      return official;
    }
    if (kind.kind === "authored") return authored;
    throw new Error(`[workwell] ${id} is not runnable here (${kind.kind}${"reason" in kind ? `: ${kind.reason}` : ""})`);
  };
  // On the Maui profile every subject IS a corpus patient, and one whole record answers every measure
  // — so the corpus source serves all of them rather than being one branch of the dispatch. The
  // runnable check still runs first: a measure the profile cannot run must fail the same way here as
  // anywhere else, and returning a bundle for it would hide that.
  if (DEPLOYMENT_PROFILE.id === "maui") {
    const corpus = sources.corpus ?? corpusBundleSource();
    // Both checks, in this order. `pick` classifies the measure against the routing env as it does on
    // every profile; the LIST check is the one this profile adds — a scoped deployment must not hand
    // back a plausible-looking patient bundle for an occupational measure it does not run. It reads
    // the profile's own list rather than `isRunnableMeasure`, which consults process.env and would
    // disagree with the `env` this composite was handed.
    const gate = (id: string): void => {
      pick(id);
      if (!(DEPLOYMENT_PROFILE.runnableMeasureIds as readonly string[]).includes(id)) {
        throw new Error(`[workwell] ${id} is not runnable here (not in the ${DEPLOYMENT_PROFILE.id} profile's measure set)`);
      }
    };
    return {
      targetFor: (employees, id, subjectId) => (gate(id), corpus.targetFor(employees, id, subjectId)),
      distribution: (employees, id) => (gate(id), corpus.distribution(employees, id)),
      bundleFor: (employee, id, target, evaluationDate) => (gate(id), corpus.bundleFor(employee, id, target, evaluationDate)),
      bundleForSubject: (employee, evaluationDate) => corpus.bundleForSubject!(employee, evaluationDate),
    };
  }

  return {
    targetFor: (employees, id, subjectId) => pick(id).targetFor(employees, id, subjectId),
    distribution: (employees, id) => pick(id).distribution(employees, id),
    bundleFor: (employee, id, target, evaluationDate) => pick(id).bundleFor(employee, id, target, evaluationDate),
    // Offered only when EVERY source behind this composite offers it: the pipeline treats its presence
    // as "one bundle answers every measure", which is false the moment one measure needs its own.
    ...(authored.bundleForSubject && official.bundleForSubject
      ? { bundleForSubject: (employee: EmployeeProfile, evaluationDate: string) => authored.bundleForSubject!(employee, evaluationDate) }
      : {}),
  };
}
