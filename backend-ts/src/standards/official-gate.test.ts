/**
 * THE RULE (roadmap §7.4 PR-6): no measure may enter `WORKWELL_OFFICIAL_MEASURES` without a green
 * official MADiE test-case gate.
 *
 * The gate itself runs in CI (`pnpm test:official-cases`, the `official-cases` job) because it clones
 * official content from the network. What this file enforces locally is the part that can silently rot:
 * that the set of measures the gate COVERS is exactly the set we have VENDORED. Two ways that breaks —
 *
 *   1. vendor an artifact and forget to gate it → it could be flipped to official with no external
 *      validation at all, which is precisely the thing the rule exists to prevent; or
 *   2. gate a measure with no vendored artifact → the harness fails in CI for a confusing reason.
 *
 * Both are caught here, in the default suite, with no network.
 *   node --import tsx --test src/standards/official-gate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OFFICIAL_GATED_MEASURES, officialMeasureName } from "./official-cases.ts";

const ARTIFACT_ROOT = fileURLToPath(new URL("../../measures/official/", import.meta.url));

const vendoredCatalogIds = readdirSync(ARTIFACT_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test("the gate covers exactly the vendored measures — no artifact is ungated, no gate is artifact-less", () => {
  assert.deepEqual(
    [...OFFICIAL_GATED_MEASURES].sort(),
    vendoredCatalogIds,
    "vendoring a measure without gating it would let it be flipped to official with no external " +
      "validation; gating one without vendoring it fails CI confusingly. Keep the two sets identical.",
  );
});

test("each gated measure's upstream name matches its manifest, so the harness finds its bundle", () => {
  for (const catalogId of OFFICIAL_GATED_MEASURES) {
    const manifest = JSON.parse(
      readFileSync(`${ARTIFACT_ROOT}${catalogId}/manifest.json`, "utf8"),
    ) as { measureName: string };
    // The harness locates the fetched upstream bundle by this name. A mismatch is a silent
    // "no test cases found" in CI rather than an obvious failure, so pin it to the manifest.
    assert.equal(
      officialMeasureName(catalogId),
      manifest.measureName,
      `${catalogId}: the harness name must match the vendored manifest's measureName`,
    );
  }
});

test("the committed evidence report names every gated measure", () => {
  // The report is the artifact we point people at (and CI fails if it is stale). If a measure is
  // gated but absent from it, the evidence does not actually cover what we claim it covers.
  const report = readFileSync(new URL("../../../docs/OFFICIAL_TESTCASE_REPORT_2026-07.md", import.meta.url), "utf8");
  for (const catalogId of OFFICIAL_GATED_MEASURES) {
    assert.match(
      report,
      new RegExp(catalogId.toUpperCase()),
      `${catalogId} is gated but does not appear in the committed evidence report`,
    );
  }
});
