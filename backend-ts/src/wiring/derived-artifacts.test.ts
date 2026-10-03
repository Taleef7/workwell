/**
 * The static guard over `measures/derived/`: every committed translation must load as a translation, pin
 * its own bundle bytes, and pass every router construction check the committed files can decide — in the
 * default suite, so an unfit translation fails CI before any stack could be configured to route it.
 *
 * C2 commits none: the directory holds only the QI-Core model info and the NOTICE. The guard must still
 * SEE the model-info directory and skip it, or a future translation named oddly could hide the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { derivedCms137 } from "../test-support/derived-fixture.ts";
import { officialRoutingProblems } from "./executor-router.ts";
import { loadDerivedArtifact, type OfficialArtifact } from "./official-artifacts.ts";

const DERIVED_DIR = fileURLToPath(new URL("../../measures/derived/", import.meta.url));
const VALID_CATALOG_ID = /^[a-z0-9]+$/;
const dirs = readdirSync(DERIVED_DIR).filter((name) => statSync(`${DERIVED_DIR}${name}`).isDirectory());
const artifacts = dirs.filter((name) => VALID_CATALOG_ID.test(name));

/**
 * The router's problems for one translation, with the build-time sidecar stubbed as present: the stubs
 * stand in for the gitignored terminology, so EVERY sentence the router can still raise is a fault in the
 * committed files. No keyword filter — filtering on a word once hid the check-record sentences.
 */
function guardProblems(id: string, loadDerived: (catalogId: string) => OfficialArtifact | null = loadDerivedArtifact): string[] {
  return officialRoutingProblems(
    { WORKWELL_OFFICIAL_MEASURES: id, WORKWELL_DERIVED_MEASURES: id } as never,
    { loadTerminology: () => ({ ok: true, codesByOid: new Map() }), cappedFor: () => [], absentFor: () => [], loadDerived },
  ).filter((p) => p.startsWith(`${id}:`) || p.startsWith(`${id} `));
}

test("the guard sees the model-info directory, skips it, and finds no translation yet", () => {
  assert.ok(dirs.includes("_modelinfo"), "the guard must be looking at the right directory");
  assert.ok(!VALID_CATALOG_ID.test("_modelinfo"), "and the model info can never be mistaken for a translation");
  assert.deepEqual(artifacts, [], "C2 commits no translation; C3a's first one must pass the test below");
  assert.ok(existsSync(`${DERIVED_DIR}NOTICE.md`));
});

test("the guard has teeth: a fit translation passes, and stale check records or a missing release fail it", () => {
  const fit = derivedCms137();
  assert.deepEqual(guardProblems("cms137", () => fit), []);
  const oracles = fit.manifest.derived!.oracles;
  const variants: Array<[string, OfficialArtifact]> = [
    ["no terminology-equivalence check", { ...fit, manifest: { ...fit.manifest, derived: { ...fit.manifest.derived!, oracles: oracles.filter((o) => o.name !== "terminology-equivalence") } } }],
    ["a stale cypress-deck record", { ...fit, manifest: { ...fit.manifest, derived: { ...fit.manifest.derived!, oracles: oracles.map((o) => (o.name === "cypress-deck" ? { ...o, ranAgainst: { ...o.ranAgainst, artifactSha256: "sha256:old" } } : o)) } } }],
    ["no VSAC release named", { ...fit, manifest: { ...fit.manifest, terminology: { ...fit.manifest.terminology!, completion: undefined } } }],
  ];
  for (const [label, translation] of variants) {
    assert.ok(guardProblems("cms137", () => translation).length > 0, `${label} must fail the guard`);
  }
});

for (const id of artifacts) {
  test(`${id}: the committed translation loads, pins its bytes, and passes every committed-file check`, () => {
    const translation = loadDerivedArtifact(id);
    assert.ok(translation, `${id} must load as a translation (manifest with a derived block, executable bundle)`);
    // The manifest's sha is what D7's check records, the cache keys, the logic version and the evidence
    // all trust; it must be the sha of the committed bytes, as for every official artifact.
    const bytes = readFileSync(`${DERIVED_DIR}${id}/bundle.json`, "utf8");
    assert.equal(translation.manifest.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`, `${id}: manifest.sha256 must pin bundle.json`);
    assert.deepEqual(guardProblems(id), []);
  });
}
