/**
 * Vendored official artifacts + their loader (roadmap §7.4 PR-5).
 *   node --import tsx --test src/wiring/official-artifacts.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadOfficialArtifact, officialArtifactAvailable } from "./official-artifacts.ts";

const ARTIFACT_ROOT = fileURLToPath(new URL("../../measures/official/", import.meta.url));
const vendored = readdirSync(ARTIFACT_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test("the expected measures are vendored", () => {
  // Hardcoded on purpose: adding a measure should be a conscious edit here, the same way the executor
  // import allowlist is (fqm-isolation.test.ts). A new artifact appearing unannounced is a review event.
  //
  // ADR-047 onboarded cms2/cms68/cms951 (MADiE 36/36, 19/19, 55/55). ADR-053 added cms138: its blocker
  // was never "one value set will not expand" — upstream's bundle declares 32 value sets and ships 31,
  // so …3.526.3.1278 has no source in the artifact at all. Sourced from VSAC at vendor time through the
  // credentialed workflow, and the gate now supplements exactly the value sets upstream omits.
  //
  // STILL absent on purpose: cms130 and cms165 have capped expansions and are not vendored, rather than
  // committed unroutable. `pnpm official:terminology-audit` says which condition any candidate has.
  assert.deepEqual(vendored.sort(), ["cms122", "cms125", "cms138", "cms2", "cms68", "cms951"]);
});

for (const catalogId of vendored) {
  test(`${catalogId}: manifest matches the bundle it describes`, () => {
    const artifact = loadOfficialArtifact(catalogId);
    assert.ok(artifact, `${catalogId} must load`);
    assert.equal(officialArtifactAvailable(catalogId), true);

    // The SHA-256 is the whole point of the manifest: it pins WHICH bytes we execute. If someone
    // hand-edits bundle.json, this fails rather than silently running an artifact nobody vendored.
    const bytes = readFileSync(`${ARTIFACT_ROOT}${catalogId}/bundle.json`, "utf8");
    assert.equal(artifact.manifest.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);

    // The SHA-256 above pins manifest -> bundle BYTES. Without this, the manifest could claim any
    // version while the bundle executes another one, and every test would still pass.
    const measure = artifact.bundle.entry.find((e) => e.resource["resourceType"] === "Measure")!.resource;
    assert.equal(artifact.manifest.version, measure["version"], "manifest version must match the Measure it describes");
    assert.equal(artifact.manifest.measureName, measure["name"]);
    assert.equal(artifact.manifest.url, measure["url"]);

    assert.equal(artifact.manifest.catalogId, catalogId);
    assert.match(artifact.manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(artifact.manifest.status, "active");
    assert.equal(artifact.manifest.scoring, "proportion");
    assert.ok(artifact.manifest.source.ref.length >= 40, "provenance must pin a full commit sha");
  });

  test(`${catalogId}: bundle carries pre-compiled ELM and no vendored ValueSet expansions`, () => {
    const artifact = loadOfficialArtifact(catalogId)!;
    const types = new Set(artifact.bundle.entry.map((e) => e.resource["resourceType"] as string));
    assert.deepEqual([...types].sort(), ["Library", "Measure"]);

    // ValueSet resources must never be vendored: 26 expansions per bundle carry thousands of AMA CPT
    // and SNOMED codes. This removes the BULK of the licensed terminology, not all of it — the official
    // CQL declares some codes inline, so the compiled ELM still embeds a few with their descriptions.
    // measures/official/NOTICE.md records that residue and its terms; do not restate this as "no
    // licensed terminology", which is false.
    assert.equal(types.has("ValueSet"), false, "vendoring ValueSet expansions would redistribute code lists in bulk");

    const libraries = artifact.bundle.entry.filter((e) => e.resource["resourceType"] === "Library");
    assert.ok(libraries.length > 0);
    for (const library of libraries) {
      const content = library.resource["content"] as Array<{ contentType?: string; data?: string }>;
      const kinds = content.map((c) => c.contentType);
      assert.deepEqual(kinds, ["application/elm+json"], "only executable ELM is kept");
      assert.ok(content[0]?.data, "ELM payload must be present");
    }
  });
}

test("an unvendored measure is absent, not an error (the tier degrades)", () => {
  assert.equal(loadOfficialArtifact("cms165"), null);
  assert.equal(officialArtifactAvailable("cms165"), false);
});

test("a traversing catalogId is REJECTED, not merely absent", () => {
  // `new URL()` normalizes `..`, so these escape measures/official/ entirely. Asserting null would
  // pass for the wrong reason - because nothing happens to live at the traversed path. Assert the id
  // is rejected before any filesystem access, since PR-7 makes this set operator-supplied.
  for (const id of ["../../etc/passwd", "../../../package", "", "cms122/../../..", "CMS122", "cms 122"]) {
    assert.equal(loadOfficialArtifact(id), null, `must reject: ${JSON.stringify(id)}`);
    assert.equal(officialArtifactAvailable(id), false);
  }
});
