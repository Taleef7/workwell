/**
 * What the OFFICIAL artifacts make of the 20,000-patient corpus — the property the pilot's numbers
 * rest on, and the one no unit test can reach.
 *
 * `corpus-membership.test.ts` proves every code the corpus stamps is a member of the artifact's own
 * expansion. `official-corpus-outcomes.test.ts` proves each SEEDED target lands in the bucket it was
 * authored for. Neither answers the question this file asks: when the measure CMS publishes scores a
 * roster generated data-first — no target, no bucket, just clinical facts at population rates — does
 * anybody land in its initial population at all?
 *
 * The failure this guards is silent by construction. A profile stamp the artifact does not name, a
 * code the retrieve does not match, an encounter dated outside the period: every one of them produces
 * a completed run in which every subject is out of population, every outcome is MISSING_DATA, and no
 * layer raises anything. A roster that reads 0% is indistinguishable from a roster nobody is eligible
 * for — and so is a roster that reads 100%.
 *
 * Runs only where the terminology sidecars are vendored, which is the credentialed CI job. It prints
 * the realized table so the numbers land in the log for the JOURNAL and for comparison against the
 * manifest's parameter-derived estimates (spec §3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { officialMeasureExecutor } from "./official-executor-adapter.ts";
import { officialTerminologyExpander, loadOfficialTerminology } from "./official-terminology.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { corpusBundleSource } from "./corpus-bundle-source.ts";
import { corpusDirectory } from "../engine/synthetic/corpus/corpus-directory.ts";
import { DEFAULT_CORPUS_SEED } from "../engine/synthetic/corpus/corpus-parameters.ts";

/** Inside the corpus's measurement year (CORPUS_MEASUREMENT_YEAR), at its end. */
const EVALUATION_DATE = "2027-12-31";

/**
 * 200 by default. Big enough that a measure whose eligible band is ~10% of the roster still gets a
 * two-figure cohort, small enough to stay one fqm pass per measure; `WORKWELL_CORPUS_POPULATION_N`
 * raises it for a deliberate larger sweep.
 */
const SIZE = Number(process.env.WORKWELL_CORPUS_POPULATION_N ?? 200);

const skipWithout = (id: string) => {
  const artifact = loadOfficialArtifact(id);
  return artifact && loadOfficialTerminology(artifact).ok
    ? false
    : `run 'pnpm vendor:official' to fetch ${id}'s terminology sidecar`;
};

const EMPLOYEES = corpusDirectory(DEFAULT_CORPUS_SEED, SIZE).EMPLOYEES;

for (const measureId of ["cms122", "cms125", "cms2", "cms130", "cms165", "cms137"]) {
  test(`official ${measureId} finds a real population in the data-first corpus`, { skip: skipWithout(measureId) }, async () => {
    const source = corpusBundleSource();
    const subjects = EMPLOYEES.map((employee) => ({
      subjectId: employee.externalId,
      patientBundle: source.bundleForSubject!(employee, EVALUATION_DATE),
    }));
    const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
    const results = await executor.evaluateBatch(measureId, subjects, EVALUATION_DATE);

    const counts: Record<string, number> = {};
    let inIpp = 0;
    for (const [, result] of results) {
      counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
      if (result.inInitialPopulation) inIpp += 1;
    }
    console.log(`[corpus] ${measureId}: n=${SIZE} returned=${results.size} inIPP=${inIpp} ${JSON.stringify(counts)}`);

    // Every subject is answered. An absent subject is not a zero — it is a subject fqm returned
    // nothing for, and averaging it into a rate would understate the denominator silently.
    assert.equal(results.size, SIZE, `${results.size} of ${SIZE} subjects came back`);
    assert.ok(inIpp > 0, `${measureId}: nobody is in the initial population — profile stamp, code or date mismatch`);
    // Non-degeneracy, both directions. A single-valued outcome column is the shape every one of this
    // corpus's real defects has taken, and it looks like a clean run at every other layer.
    assert.ok(
      new Set(Object.values(counts).filter((n) => n > 0)).size > 0 && Object.keys(counts).length > 1,
      `${measureId}: every subject scored ${Object.keys(counts)[0]} — the corpus is degenerate for this measure`,
    );
  });
}
