/**
 * The corpus as a `SubjectBundleSource` — the seam the run pipeline evaluates through (spec §4).
 *
 * This lives in `wiring/`, not in `engine/synthetic/corpus/` with the generator it calls: implementing
 * an app-side port is wiring by definition, and the engine boundary test refuses the import that would
 * be needed the other way round.
 *
 * The corpus is DATA-FIRST: it emits clinical facts at population rates and CQL decides every
 * outcome (docs/AI_GUARDRAILS.md §1). So there is no seeded bucket to honour here, and the bundle a
 * subject carries does not depend on which measure is asking — one whole record answers all six.
 */
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import type { TargetOutcome } from "../engine/synthetic/exam-config.ts";
import type { SeededAssignment } from "../run/distribution.ts";
import type { SubjectBundleSource } from "./subject-bundle-source.ts";
import { DEFAULT_CORPUS_SEED } from "../engine/synthetic/corpus/corpus-parameters.ts";
import { CORPUS_FIXTURE_PREFIX } from "../engine/synthetic/corpus/corpus-fixture-prefix.ts";
import { patientAt } from "../engine/synthetic/corpus/corpus-patient.ts";
import { bundleForPatient } from "../engine/synthetic/corpus/corpus-bundle.ts";

/**
 * `pat-001..pat-048` (the fixture prefix) and `pat-00049..` (generated) both encode their own index —
 * the prefix zero-padded to THREE digits, the generated ids to five, and the two ranges do not overlap.
 * A three-digit id past the prefix (`pat-049`) or a five-digit id inside it (`pat-00003`) parses to a
 * real index arithmetically and would otherwise return a NEIGHBOUR's whole chart, so the padding is
 * checked rather than assumed.
 *
 * This is a PADDING check, and says so rather than dressing itself up as a regeneration. An earlier
 * version compared `patientAt(seed, index).externalId` to the input, which reads like it verifies the
 * record — but `externalId` is derived from the index alone and ignores the seed and every drawn
 * field, so the comparison could only ever fail on padding, while paying a full patient generation
 * (conditions, visits, events) per call to do it.
 *
 * It is NOT bounded by the configured corpus size: nothing here knows it. `pat-20000` resolves on a
 * 48-patient deployment. Unreachable through the pipeline, whose subjects come from the directory;
 * `bundleForSubject` catches it anyway by cross-checking the identity it was handed.
 */
export function corpusIndexOf(externalId: string): number | null {
  const match = /^pat-(\d{3,5})$/.exec(externalId);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  if (index < 0) return null;
  const digits = match[1]!.length;
  const expected = index < CORPUS_FIXTURE_PREFIX.length ? 3 : 5;
  return digits === expected ? index : null;
}

export function corpusBundleSource(seed: string = DEFAULT_CORPUS_SEED): SubjectBundleSource {
  const bundleForSubject = (employee: EmployeeProfile, evaluationDate: string): FhirBundle => {
    const index = corpusIndexOf(employee.externalId);
    if (index === null) {
      throw new Error(`[workwell] ${employee.externalId} is not a corpus subject — the Maui roster is the corpus (spec §4)`);
    }
    // The NAME is the one field a standalone `patientAt` may render differently from a full
    // generation, because disambiguation depends on who came before (see `patientAt`'s note). The
    // directory already resolved it, so take it from there rather than regenerating the whole prefix.
    const generated = patientAt(seed, index);

    // The roster and the chart must be the SAME PERSON, and only this check can say so.
    //
    // `externalId` is derived from the index alone — it ignores the seed and every drawn field — so it
    // cannot detect a mismatch. Generate this subject from a different seed and you get a different
    // birth date, sex, clinic and condition list under the same id, and the id still "resolves". Every
    // outcome, case, export and card for the whole roster would then be computed from the wrong chart,
    // and the roster page would look entirely normal. These three fields are the ones the directory
    // carries, so these three are what can be compared.
    const drift =
      generated.dateOfBirth !== employee.dateOfBirth ? `dateOfBirth ${generated.dateOfBirth} vs ${employee.dateOfBirth}`
      : generated.site !== employee.site ? `site ${generated.site} vs ${employee.site}`
      : generated.providerId !== employee.providerId ? `providerId ${generated.providerId} vs ${employee.providerId}`
      // SEX is the field that makes this guard work over the FIXTURE PREFIX. The first three are taken
      // verbatim from the prefix for index < 48 and are seed-INDEPENDENT by construction, so over the
      // 48 the check could not fire at all — 0 of 48 refused under a mismatched seed, while 21 of the
      // 48 genuinely had a different sex and a different chart. `sex` is drawn from the patient's own
      // stream, so it moves with the seed AND with a generator-version change, which is the case that
      // actually bites in production: a draw-order edit leaves DOB/site/PCP pinned and silently shifts
      // every clinical fact underneath them.
      : employee.sex !== undefined && generated.sex !== employee.sex ? `sex ${generated.sex} vs ${employee.sex}`
      : null;
    if (drift) {
      throw new Error(
        `[workwell] ${employee.externalId}: the corpus chart is a different person from the roster row (${drift}). ` +
          `The bundle source and the directory are generating from different seeds or generator versions.`,
      );
    }

    const patient = { ...generated, name: employee.name };
    return bundleForPatient(patient, evaluationDate, seed) as unknown as FhirBundle;
  };

  return {
    // Every subject is evaluated, and the target is threaded through unused: the corpus decides
    // nothing about an outcome, so there is no bucket to assign. COMPLIANT is the inert value the
    // pipeline's signature requires, NOT a claim about the subject.
    targetFor: () => "COMPLIANT" as TargetOutcome,
    distribution: (employees): SeededAssignment[] =>
      employees.map((employee) => ({ employee, target: "COMPLIANT" as TargetOutcome })),
    bundleFor: (employee, _measureId, _target, evaluationDate) => bundleForSubject(employee, evaluationDate),
    bundleForSubject,
  };
}

/** The pilot's measure set, exported for the test that proves one record answers all of them. */
export const MAUI_MEASURE_IDS_FOR_TEST = ["cms122", "cms125", "cms2", "cms130", "cms165", "cms137"] as const;
