/**
 * Two implementations of "which value sets does this ELM retrieve", pinned against each other.
 *
 * `@work-well/official-executor`'s `referencedValueSets` is the one that decides ROUTING;
 * `scripts/vsac-expansion.mjs`'s `declaredValueSets` is the one that decides what the VENDOR step
 * records and completes. They must agree, and there is a hard reason they cannot be one function: the
 * vendor script runs as bare `node` on the deploy path — no install, no build step — so it cannot
 * import the workspace package.
 *
 * Two implementations of one rule is exactly the shape this project keeps finding defects in, and a
 * parity test whose two sides come from the same place is the vacuous version of the guard (see
 * `hapi-live.test.ts`, where both sides originate from one committed fixture). So both sides here are
 * the REAL functions, run over the REAL committed bundles.
 *
 * ## Why this file is `.mjs` and lives in `scripts/`
 *
 * It was first written as a `.ts` test under `src/wiring/`, which made `tsc` follow an import from
 * `src/` into `scripts/` and fail: a `.mjs` build script has no declarations. The alternatives were a
 * hand-written `.d.mts` — types that can silently drift from the code they describe, which is the
 * defect class this test exists to catch — or putting the test on the side that already depends on the
 * other. Build tooling depending on `src/` is the normal direction; `src/` depending on build tooling
 * is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { declaredValueSets, oidFromValueSetUrl } from "./vsac-expansion.mjs";
// Through the ADAPTER, never `@work-well/official-executor` directly: every direct importer is another
// door to fqm-execution that the boundary tests have to keep deliberately open (the adapter says so
// itself), and `requiredOids` is the exact function `officialRoutingProblems` feeds to its refusals —
// so this pins the vendor script against the thing that actually decides routing.
import { requiredOids } from "../src/wiring/official-executor-adapter.ts";
import { loadOfficialArtifact } from "../src/wiring/official-artifacts.ts";
import { OFFICIAL_GATED_MEASURES } from "../src/standards/official-cases.ts";

// The SHARED normalizer, not a local `split()`. A private copy here would be a fourth
// implementation of the rule this file exists to keep down to two — and it would hide exactly the
// version-suffix divergence review of #364 found, by normalizing both sides the same wrong way.
const oidOf = oidFromValueSetUrl;

test("the vendor script and the executor agree on what an ELM retrieves, on every vendored artifact", () => {
  const checked = [];
  for (const id of OFFICIAL_GATED_MEASURES) {
    const artifact = loadOfficialArtifact(id);
    if (!artifact) continue;
    const fromExecutor = [...requiredOids(artifact)].sort();
    const fromVendorScript = declaredValueSets(artifact.bundle).map((v) => oidOf(v.url)).sort();
    assert.deepEqual(fromVendorScript, fromExecutor, `${id}: the two implementations disagree`);
    checked.push(id);
  }
  // Non-degeneracy. "They agree" is trivially true over nothing, and if the vendored artifacts ever
  // stop loading here this must fail rather than silently assert zero comparisons — the shape that let
  // four tests in this repo read as covered while never running (#350, #352).
  assert.ok(checked.length >= 5, `expected at least 5 vendored artifacts to compare, got ${checked.length}`);
});

const CMS138 = fileURLToPath(
  new URL(
    "../.official-content/bundles/measure/CMS138FHIRTobaccoScrnCessation/CMS138FHIRTobaccoScrnCessation-bundle.json",
    import.meta.url,
  ),
);

function upstreamSkip() {
  try {
    readFileSync(CMS138);
    return false;
  } catch {
    return "needs the .official-content sparse checkout (gitignored; `pwsh scripts/fetch-official-cases.ps1`)";
  }
}

test("CMS138 declares 32 value sets and ships 31 — the measurement ADR-053 rests on", { skip: upstreamSkip() }, () => {
  // Asserted against the upstream bundle rather than quoted from a note. Self-skips without the sparse
  // checkout, which is why it is NOT the guard — the parity test above is, and that one always runs.
  const bundle = JSON.parse(readFileSync(CMS138, "utf8"));
  const shipped = new Set(
    bundle.entry
      .filter((e) => e.resource?.resourceType === "ValueSet")
      .map((e) => oidOf(String(e.resource.url ?? e.resource.id ?? ""))),
  );
  const retrieved = declaredValueSets(bundle);
  const absent = retrieved.map((v) => oidOf(v.url)).filter((oid) => !shipped.has(oid));

  assert.equal(retrieved.length, 32);
  assert.equal(shipped.size, 31);
  assert.deepEqual(absent, ["2.16.840.1.113883.3.526.3.1278"], "one value set is retrieved but not shipped");
});
