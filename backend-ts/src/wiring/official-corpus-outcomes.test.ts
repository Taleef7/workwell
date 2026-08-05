/**
 * What the OFFICIAL artifact makes of the synthetic corpus — the property PR-9's flip depends on.
 *
 * `corpus-membership.test.ts` proves the codes are right. This proves the consequence: that each
 * synthetic target lands in the bucket it was authored to land in when the measure CMS publishes is the
 * one doing the scoring. The two are worth separating, because a corpus can carry perfectly valid codes
 * and still be scored wrongly — every failure fixed on this branch was of exactly that kind (a missing
 * `us-core-sex` extension, a mammogram recorded only as a Procedure, a Condition with no onset).
 *
 * ## The failure mode this is really guarding
 *
 * Before this branch, official CMS122 scored the synthetic EXCLUDED cohort as COMPLIANT and official
 * CMS125 put the entire roster out-of-population. Neither raises anything: a run completes, every
 * subject gets an outcome, and `hasRetrieveSignal` passes because retrieves *did* match. The roster just
 * quietly reads better than reality. A corpus that scores 100% COMPLIANT is the most dangerous state
 * this pipeline can be in, precisely because it is indistinguishable from success at every other layer.
 *
 * The non-degeneracy assertions run BEFORE the table comparison for that reason. Review pointed out
 * they were dead code after it — `EXPECTED` already holds three distinct values, so a passing
 * `deepEqual` implies them. Ahead of it they still catch the realistic regression: an `EXPECTED` table
 * someone flattened to turn a red build green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { bundledEcqmValueSetResolver } from "../engine/cql/bundled-ecqm-expansions.ts";
import { directSyntheticGenerator, webChartRealisticGenerator } from "../run/scale-generator.ts";
import { officialMeasureExecutor } from "./official-executor-adapter.ts";
import { officialTerminologyExpander, loadOfficialTerminology } from "./official-terminology.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { createWorkwellEngine } from "../engine/cql/workwell-engine.ts";

const EVALUATION_DATE = "2026-07-27";

/**
 * What each synthetic target means once an eCQM scores it.
 *
 * `DUE_SOON` and `MISSING_DATA` both land on OVERDUE, and that is correct rather than sloppy: neither
 * measure has a forecast concept, and for CMS122 "no glycemic assessment on record" IS the numerator.
 * Identical for both measures today; kept per-measure because the sixth measure onboarded will not be.
 */
const EXPECTED: Record<string, Record<TargetOutcome, string>> = {
  cms122: {
    COMPLIANT: "COMPLIANT",
    DUE_SOON: "OVERDUE",
    OVERDUE: "OVERDUE",
    MISSING_DATA: "OVERDUE",
    EXCLUDED: "EXCLUDED",
  },
  cms125: {
    COMPLIANT: "COMPLIANT",
    DUE_SOON: "OVERDUE",
    OVERDUE: "OVERDUE",
    MISSING_DATA: "OVERDUE",
    EXCLUDED: "EXCLUDED",
  },
};

const sidecarsPresent = ["cms122", "cms125"].every((id) => {
  const artifact = loadOfficialArtifact(id);
  return !!artifact && loadOfficialTerminology(artifact).ok;
});
const skip = sidecarsPresent ? false : "run 'pnpm vendor:official' to fetch the terminology sidecars";

/**
 * Both bundle sources, because covering only one is how this defect class comes back.
 *
 * `directSyntheticGenerator` wraps `deriveExamConfig` + `buildSyntheticBundle` — the live-tenant run
 * path. `webChartRealisticGenerator` re-codes those bundles to real WebChart terminology and is the
 * DEFAULT for `seed:scale --mode evaluate`, which produced the live `mhn` tenant's outcomes. Review
 * caught it overwriting the LOINC mammogram `Observation` with the CPT code and putting the entire
 * scale population back out of CMS125's numerator — invisible to a guard that only knew about the
 * first source.
 */
const SOURCES = [directSyntheticGenerator(), webChartRealisticGenerator()];

for (const generator of SOURCES) {
  for (const [measureId, expected] of Object.entries(EXPECTED)) {
    test(`official ${measureId} scores the ${generator.kind} corpus as authored`, { skip }, async () => {
      const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
      const authored = createWorkwellEngine({ valueSetResolver: bundledEcqmValueSetResolver });
      const actual: Record<string, string> = {};
      const authoredOutcomes: Record<string, string> = {};

      for (const target of Object.keys(expected) as TargetOutcome[]) {
        const bundle = generator.bundleFor(`corpus-${target}`, measureId, target, EVALUATION_DATE);
        const input = { measureId, patientBundle: bundle, evaluationDate: EVALUATION_DATE };
        actual[target] = (await executor.evaluate(input)).outcome;
        authoredOutcomes[target] = (await authored.evaluate(input)).outcome;
      }

      // Non-degeneracy, asserted BEFORE the comparison rather than after. A corpus scored entirely
      // COMPLIANT looks like good news and is the failure this whole file exists for — but after a
      // passing `deepEqual(actual, expected)` the check is dead code, since `expected` already holds
      // three distinct values. Ahead of it, it still catches an `EXPECTED` table someone flattened to
      // make a red build green, which is the realistic way this protection gets lost.
      assert.ok(new Set(Object.values(expected)).size > 1, "the EXPECTED table is degenerate");
      assert.ok(new Set(Object.values(actual)).size > 1, "every target scored the same — corpus is degenerate");

      assert.deepEqual(actual, expected);
      // The authored path agrees on every target TODAY, which is what makes PR-9's flip a config change
      // rather than a roster rewrite. A failure here is a finding to investigate, not necessarily a bug:
      // the two measures are different logic and are allowed to disagree. What is not allowed is
      // disagreeing without anyone noticing.
      assert.deepEqual(authoredOutcomes, expected, "authored/official divergence — investigate before PR-9");
    });
  }
}
