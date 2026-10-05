/**
 * The pure half of building a translation: its name, WorkWell's edits, the ELM strip, the bundle and the
 * manifest. Everything here runs on the COMMITTED official cms137 artifact or on CQL-shaped text written
 * for the test; no CMS CQL is read and nothing is written to `measures/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadOfficialArtifact, type OfficialManifest } from "../wiring/official-artifacts.ts";
import {
  applyEdits,
  assembleTranslationBundle,
  derivedManifestFor,
  encodeElm,
  parseEdits,
  spanSha256,
  stripElmDebugKeys,
  translationIdentity,
  type CqlEdit,
} from "./derived-build.ts";
import {
  DERIVED_VERSION,
  derivedIdentityProblems,
  installedTranslatorVersion,
  libraryElmSha256,
  QICORE_MODEL_INFO_SHA256,
  rewriteDerivedIdentity,
  translatorId,
} from "./derived-identity.ts";

interface Res {
  resourceType?: string;
  [key: string]: unknown;
}
type B = { entry: Array<{ resource: Res }> };
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const cms137 = loadOfficialArtifact("cms137")!;
const baseBundle = cms137.bundle as unknown as B;
const measureOf = (b: B) => b.entry.find((e) => e.resource.resourceType === "Measure")!.resource;
const librariesOf = (b: B) => b.entry.filter((e) => e.resource.resourceType === "Library").map((e) => e.resource);
const mainOf = (b: B) => librariesOf(b).find((l) => l["url"] === (measureOf(b)["library"] as string[])[0])!;
const elmDataOf = (library: Res) => (library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!.data;
const decode = (data: string) => JSON.parse(Buffer.from(data, "base64").toString("utf8"));
const IDENTITY = translationIdentity("cms137", 2027, "CMS137v15");

// ---- identity -------------------------------------------------------------------------------------------

test("a translation is named for its measure, its year and its revision, never like CMS", () => {
  assert.deepEqual(IDENTITY, {
    url: "urn:workwell:measure:cms137:translation",
    version: "ww-2027.1",
    name: "WorkWellCMS137Translation2027",
    title: "WorkWell translation of CMS137v15",
    derivedFrom: "CMS137v15",
    effectivePeriod: { start: "2027-01-01", end: "2027-12-31" },
  });
  assert.ok(DERIVED_VERSION.test(IDENTITY.version));
  assert.equal(translationIdentity("cms2", 2028, "CMS2v16", 3).version, "ww-2028.3");
  assert.equal(translationIdentity("cms2", 2028, "CMS2v16").name, "WorkWellCMS2Translation2028");
  assert.throws(() => translationIdentity("CMS137", 2027, "CMS137v15"), /lower-case/);
  assert.throws(() => translationIdentity("cms137", 27, "CMS137v15"), /four-digit year/);
  assert.throws(() => translationIdentity("cms137", 2027, "CMS137v15", 0), /positive integer/);
  assert.throws(() => translationIdentity("cms137", 2027, " "), /derivedFrom/);
});

// ---- edits ----------------------------------------------------------------------------------------------

// CQL-shaped text written for this test, not CMS's.
const SOURCE = ["library Demo version '1'", "", "define \"A\": 1", "define \"B\": 2", "define \"C\": 3", "define \"D\": 4", "define \"E\": 5"].join("\n") + "\n";
const edit = (startLine: number, endLine: number, replacement: string, cql = SOURCE): CqlEdit => ({
  library: "Demo",
  anchorSha256: spanSha256(cql, startLine, endLine),
  startLine,
  endLine,
  replacement,
});

test("no edits is the input exactly, line endings included", () => {
  const crlf = SOURCE.replace(/\n/g, "\r\n");
  assert.equal(applyEdits(crlf, []), crlf);
  assert.equal(applyEdits(SOURCE, []), SOURCE);
});

test("an edit replaces exactly its anchored lines, and an anchor on other text is refused by library and lines", () => {
  assert.equal(applyEdits(SOURCE, [edit(4, 4, "define \"B\": 20")]), SOURCE.replace("define \"B\": 2\n", "define \"B\": 20\n"));
  // Anchored on the LF text, so a CRLF checkout of the same source takes the same edit.
  assert.equal(applyEdits(SOURCE.replace(/\n/g, "\r\n"), [edit(4, 4, "define \"B\": 20")]), SOURCE.replace("define \"B\": 2\n", "define \"B\": 20\n"));
  assert.equal(applyEdits(SOURCE, [edit(3, 4, "")]), SOURCE.replace("define \"A\": 1\ndefine \"B\": 2\n", ""), "\"\" deletes the span");
  // A replacement written on Windows lands as LF, so the translated CQL's hash does not depend on the editor.
  assert.equal(applyEdits(SOURCE, [edit(4, 4, "define \"B\": 20\r\ndefine \"B2\": 21")]), SOURCE.replace("define \"B\": 2\n", "define \"B\": 20\ndefine \"B2\": 21\n"));

  const stale = { ...edit(4, 4, "x"), anchorSha256: spanSha256(SOURCE, 5, 5) };
  assert.throws(() => applyEdits(SOURCE, [stale]), /edit of Demo lines 4-4 is anchored to sha256:[0-9a-f]{64}, but those lines hash to sha256:[0-9a-f]{64}/);
  // The refusal names hashes, never the text it compared.
  assert.throws(() => applyEdits(SOURCE, [stale]), (error: Error) => !error.message.includes("define"));
  assert.throws(() => applyEdits(SOURCE, [{ ...edit(7, 7, "x"), endLine: 8 }]), /Demo lines 7-8 is outside the source's 7 lines/);
  assert.throws(() => applyEdits(SOURCE, [{ ...edit(5, 5, "x"), startLine: 6 }]), /outside the source/);
});

test("edits are applied bottom-up, so one that changes the line count never moves another's lines", () => {
  const grow = edit(3, 3, "define \"A\": 1\ndefine \"A2\": 11\ndefine \"A3\": 111");
  const shrink = edit(5, 6, "define \"CD\": 34");
  const want = ["library Demo version '1'", "", "define \"A\": 1", "define \"A2\": 11", "define \"A3\": 111", "define \"B\": 2", "define \"CD\": 34", "define \"E\": 5"].join("\n") + "\n";
  assert.equal(applyEdits(SOURCE, [grow, shrink]), want);
  assert.equal(applyEdits(SOURCE, [shrink, grow]), want, "the order of the file does not matter");
  assert.throws(() => applyEdits(SOURCE, [edit(3, 5, "x"), edit(5, 6, "y")]), /Demo lines 3-5 and 5-6 overlap/);
});

test("an edits file is an explicit array of complete edits", () => {
  assert.deepEqual(parseEdits([]), []);
  const good = edit(4, 4, "define \"B\": 20");
  assert.deepEqual(parseEdits([{ ...good, reason: "2027 change" }]), [{ ...good, reason: "2027 change" }]);
  assert.throws(() => parseEdits({}), /JSON array/);
  assert.throws(() => parseEdits([{ ...good, replacment: "typo" }]), /unknown key\(s\) replacment/);
  assert.throws(() => parseEdits([{ ...good, anchorSha256: "sha256:abc" }]), /anchorSha256 must be sha256/);
  assert.throws(() => parseEdits([{ ...good, startLine: 0 }]), /startLine must be a positive integer/);
  assert.throws(() => parseEdits([{ ...good, endLine: 1.5 }]), /endLine must be a positive integer/);
  const { replacement: _r, ...noReplacement } = good;
  assert.throws(() => parseEdits([noReplacement]), /replacement must be a string/);
  assert.throws(() => parseEdits([{ ...good, library: "" }]), /names no library/);
});

// ---- the strip ------------------------------------------------------------------------------------------

test("the strip removes annotation, locator and localId at every depth and nothing else", () => {
  const elm = {
    library: {
      annotation: [{ type: "CqlToElmInfo" }],
      identifier: { id: "Demo", version: "1" },
      statements: {
        def: [
          { localId: "1", locator: "3:1-3:9", name: "A", expression: { localId: "2", type: "Literal", value: "1", annotation: [{ s: {} }] } },
          { name: "B", operand: [[{ localId: "3", type: "Null" }]] },
        ],
      },
    },
  };
  const before = JSON.stringify(elm);
  assert.deepEqual(stripElmDebugKeys(elm), {
    library: {
      identifier: { id: "Demo", version: "1" },
      statements: { def: [{ name: "A", expression: { type: "Literal", value: "1" } }, { name: "B", operand: [[{ type: "Null" }]] }] },
    },
  });
  assert.equal(JSON.stringify(elm), before, "the input is not modified");
});

test("the strip is a byte-for-byte no-op on every committed official cms137 library, so it is the vendor script's strip", () => {
  const libraries = librariesOf(baseBundle);
  assert.equal(libraries.length, 7);
  for (const library of libraries) {
    const data = elmDataOf(library);
    assert.equal(encodeElm(stripElmDebugKeys(decode(data))), data, `${String(library["name"])} re-encodes to its committed bytes`);
  }
});

// ---- the bundle -----------------------------------------------------------------------------------------

/** CMS's main-library ELM with the debug keys a fresh compile carries, standing in for our compile. */
function compiledMainElm() {
  const elm = decode(elmDataOf(mainOf(baseBundle)));
  elm.library.annotation = [{ type: "CqlToElmInfo", translatorOptions: "EnableAnnotations", signatureLevel: "All" }];
  elm.library.statements.def[0].localId = "9";
  elm.library.statements.def[0].locator = "1:1-1:9";
  return elm;
}

test("the assembled bundle carries CMS's Measure and shared libraries as they are, and only OUR main ELM, stripped", () => {
  const before = JSON.stringify(baseBundle);
  const { bundle, unchangedLibraries } = assembleTranslationBundle(baseBundle, compiledMainElm(), IDENTITY);
  assert.equal(JSON.stringify(baseBundle), before, "CMS's committed bundle is not modified");

  // The Measure is CMS's, changed only by the identity rewrite.
  assert.deepEqual(measureOf(bundle), measureOf(rewriteDerivedIdentity(baseBundle, IDENTITY)));
  const cmsMainName = String(mainOf(baseBundle)["name"]);
  const shared = librariesOf(baseBundle).filter((l) => l["name"] !== cmsMainName);
  assert.equal(shared.length, 6);
  for (const library of shared) {
    const ours = librariesOf(bundle).find((l) => l["name"] === library["name"])!;
    assert.deepEqual(ours, library, `${String(library["name"])} is carried verbatim`);
    assert.equal(elmDataOf(ours), elmDataOf(library), `${String(library["name"])}'s content[].data is byte-identical`);
  }
  assert.deepEqual(
    unchangedLibraries,
    shared.map((l) => ({ name: String(l["name"]), version: String(l["version"]), elmSha256: libraryElmSha256(l) })),
  );

  const main = mainOf(bundle);
  assert.deepEqual((main["content"] as Array<{ contentType: string }>).map((c) => c.contentType), ["application/elm+json"]);
  const elm = decode(elmDataOf(main));
  assert.ok(!/"(annotation|locator|localId)":/.test(JSON.stringify(elm)), "the compiled ELM's debug keys are stripped");
  assert.deepEqual(elm.library.identifier, { id: IDENTITY.name, version: IDENTITY.version });
});

test("the assembler refuses ELM that is not the main library's, and a base carrying anything but a Measure and Libraries", () => {
  const other = decode(elmDataOf(librariesOf(baseBundle).find((l) => l["name"] === "Hospice")!));
  assert.throws(() => assembleTranslationBundle(baseBundle, other, IDENTITY), /compiled ELM is Hospice\|6\.18\.000, not the main library CMS137FHIRSUDTxInitEngagement\|1\.0\.000/);
  const withValueSet = { entry: [...baseBundle.entry, { resource: { resourceType: "ValueSet", id: "vs" } }] };
  assert.throws(() => assembleTranslationBundle(withValueSet, compiledMainElm(), IDENTITY), /carries ValueSet; a translation holds only a Measure and its Libraries/);
});

// ---- the manifest ---------------------------------------------------------------------------------------

const TERMINOLOGY = {
  file: "terminology.json",
  valueSets: 28,
  codes: 1000,
  truncated: [],
  completion: { source: "vsac", manifest: "http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14", valueSets: [] },
  sha256: `sha256:${"d".repeat(64)}`,
};
const assembled = assembleTranslationBundle(baseBundle, compiledMainElm(), IDENTITY);
const bundleJson = `${JSON.stringify(assembled.bundle, null, 0)}\n`;
const BUILD = {
  translator: translatorId(installedTranslatorVersion()),
  modelInfoSha256: `sha256:${QICORE_MODEL_INFO_SHA256}`,
  signatureLevel: "All",
  translationSha256: `sha256:${"b".repeat(64)}`,
};
const manifestFor = (previous?: Pick<OfficialManifest, "sha256" | "terminology" | "derived"> | null, terminologyBlock = TERMINOLOGY) =>
  derivedManifestFor({
    base: cms137,
    bundleJson,
    identity: IDENTITY,
    build: BUILD,
    unchangedLibraries: assembled.unchangedLibraries,
    packageSha256: `sha256:${"a".repeat(64)}`,
    terminologyBlock,
    previous,
  });
const ORACLE = {
  name: "cypress-deck",
  inputSha256: `sha256:${"c".repeat(64)}`,
  period: { start: "2025-01-01", end: "2025-12-31" },
  agree: 36,
  total: 36,
  result: "pass" as const,
  ranAgainst: { artifactSha256: sha(bundleJson), terminologySha256: TERMINOLOGY.sha256 },
};

test("the manifest is keyed like CMS's, with derived last and no deck, and passes the router's identity check", () => {
  const { manifest, warnings } = manifestFor(null);
  const { tests: _deck, ...cmsKeys } = cms137.manifest;
  assert.deepEqual(Object.keys(manifest), [...Object.keys(cmsKeys), "derived"]);
  assert.equal(manifest.tests, undefined);
  assert.equal(manifest.sha256, sha(bundleJson));
  assert.equal(manifest.measureName, IDENTITY.name);
  assert.equal(manifest.cmsId, null);
  assert.equal(manifest.status, "draft");
  for (const field of ["scoring", "populationBasis", "improvementNotation", "populations", "source"] as const) {
    assert.deepEqual(manifest[field], cms137.manifest[field], `${field} is CMS's`);
  }
  assert.deepEqual(Object.keys(manifest.reduction), Object.keys(cms137.manifest.reduction));
  assert.equal(manifest.reduction["vendoredBytes"], Buffer.byteLength(bundleJson));
  assert.deepEqual(manifest.terminology, TERMINOLOGY);
  assert.deepEqual(manifest.derived, {
    label: IDENTITY.title,
    derivedFrom: { ecqm: "CMS137v15", packageSha256: `sha256:${"a".repeat(64)}` },
    base: { catalogId: "cms137", manifestSha256: cms137.manifest.sha256 },
    build: BUILD,
    unchangedLibraries: assembled.unchangedLibraries,
    oracles: [],
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(derivedIdentityProblems(JSON.parse(bundleJson), manifest, cms137), []);
});

test("oracle records survive a rebuild only when the artifact AND its terminology are the ones they ran against", () => {
  const previous = (artifactSha256: string, terminologySha256: string) => ({
    sha256: artifactSha256,
    terminology: { ...TERMINOLOGY, sha256: terminologySha256 },
    derived: { ...manifestFor(null).manifest.derived!, oracles: [ORACLE] },
  });
  const same = manifestFor(previous(sha(bundleJson), TERMINOLOGY.sha256));
  assert.deepEqual(same.manifest.derived!.oracles, [ORACLE], "an identical rebuild keeps its checks");
  assert.deepEqual(same.warnings, []);

  const CLEARED = ["oracle records cleared: the artifact changed; re-run derived:check --record"];
  const bundleChanged = manifestFor(previous(`sha256:${"9".repeat(64)}`, TERMINOLOGY.sha256));
  assert.deepEqual(bundleChanged.manifest.derived!.oracles, [], "a changed bundle clears them");
  assert.deepEqual(bundleChanged.warnings, CLEARED);
  const terminologyChanged = manifestFor(previous(sha(bundleJson), `sha256:${"8".repeat(64)}`));
  assert.deepEqual(terminologyChanged.manifest.derived!.oracles, [], "a re-expanded terminology clears them");
  assert.deepEqual(terminologyChanged.warnings, CLEARED);

  // Nothing to clear, nothing to warn about.
  assert.deepEqual(manifestFor({ ...previous(`sha256:${"9".repeat(64)}`, TERMINOLOGY.sha256), derived: { ...manifestFor(null).manifest.derived!, oracles: [] } }).warnings, []);
});
