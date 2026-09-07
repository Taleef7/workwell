/**
 * CMS165 asks for blood pressures and, with profiles ignored, is handed every Observation.
 *
 * ## The defect
 *
 * `[Observation: us-core-blood-pressure]` is the only Observation retrieve in the whole cms165 artifact
 * with NO code filter — the other four (hospice, palliative care, frailty, advanced illness) each name a
 * code or a value set, so they are safe whatever happens to profiles. That one identifies a blood
 * pressure by PROFILE ALONE, and `Status.isObservationBP` narrows it only by `status`.
 *
 * The official executor runs `trustMetaProfile: false` (deliberately — trusting profiles empties the
 * population for cms122 and cms125, which ARE routed). With profiles ignored, "a blood pressure" becomes
 * "any final Observation": a hemoglobin result, a depression screening, a colonoscopy finding. Whichever
 * of those is most recent is read as the patient's latest blood pressure, and it has no systolic or
 * diastolic component to read.
 *
 * The old synthetic fixture emitted exactly one Observation per subject, which is the only shape that
 * hides this. Every real patient has other results, and so does the ADR-075 corpus.
 *
 * ## What is asserted
 *
 * The invariant, not a bucket: **adding a result that is not a blood pressure does not change a
 * blood-pressure measure's answer.** Scoring the same patient twice — once with only the BP Observation,
 * once with the record they actually have — must agree. That needs no prediction of which bucket cms165
 * puts them in, and it fails for exactly the reason the defect exists.
 *
 * The fix is per-measure `trustMetaProfile` (`OFFICIAL_MEASURE_SEMANTICS.cms165`), which is available
 * because the corpus stamps the profile each artifact retrieve names — `corpus-bundle.ts` has done so
 * since ADR-075 precisely so this could be turned on. It is NOT turned on globally: cms122 and cms125
 * are routed today and their populations empty out under it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { corpusPatients } from "../engine/synthetic/corpus/corpus-patient.ts";
import { DEFAULT_CORPUS_SEED } from "../engine/synthetic/corpus/corpus-parameters.ts";
import { bundleForPatient } from "../engine/synthetic/corpus/corpus-bundle.ts";
import { officialMeasureExecutor } from "./official-executor-adapter.ts";
import { officialTerminologyExpander, loadOfficialTerminology } from "./official-terminology.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";

const EVALUATION_DATE = "2026-12-31";
const BP_PROFILE = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure";

const skipWithout = (id: string) => {
  const artifact = loadOfficialArtifact(id);
  return artifact && loadOfficialTerminology(artifact).ok
    ? false
    : `run 'pnpm vendor:official' to fetch ${id}'s terminology sidecar`;
};

interface Entry {
  resource?: { resourceType?: string; meta?: { profile?: string[] } };
}

/** The same bundle with every non-blood-pressure Observation removed. Nothing else is touched. */
function bloodPressuresOnly(bundle: { entry?: Entry[] }): unknown {
  const copy = structuredClone(bundle) as { entry?: Entry[] };
  copy.entry = (copy.entry ?? []).filter((e) => {
    if (e.resource?.resourceType !== "Observation") return true;
    return (e.resource.meta?.profile ?? []).includes(BP_PROFILE);
  });
  return copy;
}

/**
 * A corpus patient who has a blood pressure AND a later result that is not one. Chosen by searching
 * rather than hardcoded: the corpus is generated, and pinning `pat-007` would make this test a hostage
 * to an unrelated change in the draw order. The search states the shape it needs.
 */
function subjectWithALaterNonBpResult() {
  for (const patient of corpusPatients(DEFAULT_CORPUS_SEED, 400, 2026)) {
    const bp = patient.events.filter((e) => e.kind === "bp");
    if (bp.length === 0) continue;
    const newestBp = bp.map((e) => e.date).sort().at(-1)!;
    const laterOther = patient.events.filter((e) => e.kind !== "bp" && e.date > newestBp);
    if (laterOther.length > 0) return { patient, newestBp, laterOther };
  }
  throw new Error("no corpus patient has a blood pressure followed by another kind of result");
}

test("cms165 reads a blood pressure, not whichever Observation happens to be newest", { skip: skipWithout("cms165") }, async () => {
  const { patient, laterOther } = subjectWithALaterNonBpResult();
  assert.ok(laterOther.length > 0, "the fixture must actually carry a later non-BP result");

  const full = bundleForPatient(patient, EVALUATION_DATE);
  const bpOnly = bloodPressuresOnly(full as unknown as { entry?: Entry[] });

  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  const score = async (bundle: unknown) =>
    (await executor.evaluate({ measureId: "cms165", patientBundle: bundle, evaluationDate: EVALUATION_DATE })).outcome;

  const withOtherResults = await score(full);
  const withBloodPressureAlone = await score(bpOnly);

  assert.equal(
    withOtherResults,
    withBloodPressureAlone,
    `${patient.externalId}: adding ${laterOther.map((e) => e.kind).join(", ")} changed a blood-pressure ` +
      `measure's answer (${withBloodPressureAlone} → ${withOtherResults}) — the artifact's ` +
      `[Observation: us-core-blood-pressure] retrieve is matching resources that are not blood pressures`,
  );
});
