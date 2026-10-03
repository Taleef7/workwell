/**
 * The static guard over `measures/derived/`: every committed translation must load as a translation and
 * pass the identity, shape and check-record parts of the router's construction checks — in the default
 * suite, so an unfit translation fails CI before any stack could be configured to route it.
 *
 * C2 commits none: the directory holds only the QI-Core model info and the NOTICE. The guard must still
 * SEE the model-info directory and skip it, or a future translation named oddly could hide the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { officialRoutingProblems } from "./executor-router.ts";
import { loadDerivedArtifact, loadOfficialManifest } from "./official-artifacts.ts";

const DERIVED_DIR = fileURLToPath(new URL("../../measures/derived/", import.meta.url));
const VALID_CATALOG_ID = /^[a-z0-9]+$/;
const dirs = readdirSync(DERIVED_DIR).filter((name) => statSync(`${DERIVED_DIR}${name}`).isDirectory());
const artifacts = dirs.filter((name) => VALID_CATALOG_ID.test(name));

test("the guard sees the model-info directory, skips it, and finds no translation yet", () => {
  assert.ok(dirs.includes("_modelinfo"), "the guard must be looking at the right directory");
  assert.ok(!VALID_CATALOG_ID.test("_modelinfo"), "and the model info can never be mistaken for a translation");
  assert.deepEqual(artifacts, [], "C2 commits no translation; C3a's first one must pass the test below");
  assert.ok(existsSync(`${DERIVED_DIR}NOTICE.md`));
});

for (const id of artifacts) {
  test(`${id}: the committed translation loads and passes the identity, shape and check-record checks`, () => {
    const translation = loadDerivedArtifact(id);
    assert.ok(translation, `${id} must load as a translation (manifest with a derived block, executable bundle)`);
    // The sidecar is fetched at build and absent in CI's default suite, so terminology checks are the
    // official-cases job's; everything decidable from the committed files is decided here.
    const problems = officialRoutingProblems(
      { WORKWELL_OFFICIAL_MEASURES: id, WORKWELL_DERIVED_MEASURES: id } as never,
      { loadTerminology: () => ({ ok: true, codesByOid: new Map() }), cappedFor: () => [], absentFor: () => [] },
    ).filter((p) => p.startsWith(`${id}`) && !/terminology/.test(p));
    assert.deepEqual(problems, []);
    assert.equal(translation.manifest.derived?.base.manifestSha256, loadOfficialManifest(id)?.sha256, `${id} must be built on the committed official artifact`);
  });
}
