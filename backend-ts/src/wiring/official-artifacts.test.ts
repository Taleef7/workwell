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
  assert.deepEqual(vendored.sort(), ["cms122", "cms125"]);
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

    assert.equal(artifact.manifest.catalogId, catalogId);
    assert.match(artifact.manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(artifact.manifest.status, "active");
    assert.equal(artifact.manifest.scoring, "proportion");
    assert.ok(artifact.manifest.source.ref.length >= 40, "provenance must pin a full commit sha");
  });

  test(`${catalogId}: bundle carries pre-compiled ELM and NO licensed terminology`, () => {
    const artifact = loadOfficialArtifact(catalogId)!;
    const types = new Set(artifact.bundle.entry.map((e) => e.resource["resourceType"] as string));
    assert.deepEqual([...types].sort(), ["Library", "Measure"]);

    // Value sets must never be vendored: their expansions embed AMA CPT and SNOMED content that this
    // public repo cannot redistribute. Terminology comes from our own VSAC import at runtime.
    assert.equal(types.has("ValueSet"), false, "vendoring value sets would redistribute licensed codes");

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
  assert.equal(loadOfficialArtifact("../../etc/passwd"), null, "a junk id must not throw");
});
