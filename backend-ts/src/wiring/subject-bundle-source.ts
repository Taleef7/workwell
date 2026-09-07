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
import { classifyRunnable, deploymentCorpusSeed, DEPLOYMENT_PROFILE, type DeploymentProfile } from "../config/deployment-profile.ts";
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

/**
 * Dispatches on the runnable rule; throws for anything that is not runnable rather than guessing.
 *
 * `profile` defaults to the process's own deployment profile, which is what every runtime caller wants.
 * The flip gate passes it explicitly so it can compose the deployment's roster from an `env` it built
 * (the measure under test routed as a flip would route it) without depending on what this process was
 * started as — a shadow of the run pipeline rather than a second roster.
 */
export function compositeBundleSource(
  env: Record<string, unknown>,
  sources: { authored?: SubjectBundleSource; official?: SubjectBundleSource; corpus?: SubjectBundleSource } = {},
  profile: DeploymentProfile = DEPLOYMENT_PROFILE,
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
  if (profile.id === "maui") {
    // The SEED comes from the same place the directory's did — the DEPLOYMENT's (process.env), not the
    // `env` argument, which carries the ROUTING and is often partial. Defaulting it (which this did)
    // makes the bundle source and the roster disagree about who a subject is the moment
    // WORKWELL_MAUI_CORPUS_SEED is set — silently, because a subject's id is derived from their index
    // and matches under any seed. `corpusBundleSource` cross-checks the identity as well, so the two
    // have to agree and are told to when they do not. A caller that composed its OWN directory from
    // another env (the flip gate) passes `sources.corpus` built from that same seed.
    const corpus = sources.corpus ?? corpusBundleSource(deploymentCorpusSeed());
    // Both checks, in this order. `pick` classifies the measure against the routing env as it does on
    // every profile; the LIST check is the one this profile adds — a scoped deployment must not hand
    // back a plausible-looking patient bundle for an occupational measure it does not run. It reads
    // the profile's own list rather than `isRunnableMeasure`, which consults process.env and would
    // disagree with the `env` this composite was handed.
    const gate = (id: string): void => {
      pick(id);
      if (!(profile.runnableMeasureIds as readonly string[]).includes(id)) {
        throw new Error(`[workwell] ${id} is not runnable here (not in the ${profile.id} profile's measure set)`);
      }
    };
    return {
      targetFor: (employees, id, subjectId) => (gate(id), corpus.targetFor(employees, id, subjectId)),
      distribution: (employees, id) => (gate(id), corpus.distribution(employees, id)),
      bundleFor: (employee, id, target, evaluationDate) => (gate(id), corpus.bundleFor(employee, id, target, evaluationDate)),
      // NOT gated, and deliberately: `bundleForSubject` has no measureId to gate on. The refusal lives
      // at PLAN time — `resolveScope` calls the gated `distribution`/`targetFor` for every measure in
      // the run before `finishManualRun` builds a single bundle — so a measure outside the profile's
      // set never reaches here. Adding a gate that cannot see a measure id would read as protection
      // without being any.
      bundleForSubject: (employee, evaluationDate) => corpus.bundleForSubject!(employee, evaluationDate),
    };
  }

  return {
    targetFor: (employees, id, subjectId) => pick(id).targetFor(employees, id, subjectId),
    distribution: (employees, id) => pick(id).distribution(employees, id),
    bundleFor: (employee, id, target, evaluationDate) => pick(id).bundleFor(employee, id, target, evaluationDate),
    // NO `bundleForSubject` off the Maui profile, and this is a decision rather than an omission.
    // Neither source behind this composite has a measure-independent whole record: the binding source
    // derives its bundle from the measure's own exam config, and the official-only source writes a
    // shape per artifact. An earlier version forwarded the authored source's method if both happened to
    // define one — a branch that could not run today, and that on the day one of them gained the method
    // would have served AUTHORED bundles for cms2/cms130/cms165 and skipped the runnable check
    // entirely. A guard that cannot fire is worse than no guard, so there is no branch.
  };
}
