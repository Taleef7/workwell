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
  groupEditsByLibrary,
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

test("edits are grouped by library, and each library's lines are checked and applied only against that library's text", () => {
  const other = SOURCE.replace("library Demo", "library Other");
  const forOther = (startLine: number, endLine: number, replacement: string): CqlEdit => ({ ...edit(startLine, endLine, replacement, other), library: "Other" });
  const edits = [edit(3, 5, "define \"ABC\": 123"), forOther(4, 6, "define \"BCD\": 234"), edit(7, 7, "define \"E\": 50")];
  const groups = groupEditsByLibrary(edits);
  assert.deepEqual([...groups.keys()], ["Demo", "Other"], "in order of first appearance");
  assert.deepEqual(groups.get("Demo"), [edits[0], edits[2]], "each group in file order");
  // Demo's lines 3-5 and Other's lines 4-6 are different lines: no overlap, and both land.
  assert.equal(applyEdits(SOURCE, groups.get("Demo")!), ["library Demo version '1'", "", "define \"ABC\": 123", "define \"D\": 4", "define \"E\": 50"].join("\n") + "\n");
  assert.equal(applyEdits(other, groups.get("Other")!), ["library Other version '1'", "", "define \"A\": 1", "define \"BCD\": 234", "define \"E\": 5"].join("\n") + "\n");
  // Handed both libraries' edits at once, applyEdits refuses rather than compare lines across texts.
  assert.throws(() => applyEdits(SOURCE, edits), /one library's edits are applied at a time, but these name Demo, Other; group them by library first/);
  assert.deepEqual(groupEditsByLibrary([]), new Map());
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

test("the strip removes annotation and locator at every depth and nothing else", () => {
  const elm = {
    library: {
      annotation: [{ type: "CqlToElmInfo" }],
      identifier: { id: "Demo", version: "1" },
      statements: {
        def: [
          { localId: "1", locator: "3:1-3:9", name: "A", expression: { localId: "2", type: "Literal", value: "1", annotation: [{ s: {} }] } },
          { name: "B", operand: [[{ localId: "3", locator: "4:1-4:4", type: "Null" }]] },
        ],
      },
    },
  };
  const before = JSON.stringify(elm);
  assert.deepEqual(stripElmDebugKeys(elm), {
    library: {
      identifier: { id: "Demo", version: "1" },
      statements: {
        def: [
          { localId: "1", name: "A", expression: { localId: "2", type: "Literal", value: "1" } },
          { name: "B", operand: [[{ localId: "3", type: "Null" }]] },
        ],
      },
    },
  });
  assert.equal(JSON.stringify(elm), before, "the input is not modified");
});

test("localId survives the strip, at every depth: fqm reads each define's value by it", () => {
  const stripped = stripElmDebugKeys({ library: { localId: "0", statements: { def: [{ localId: "1", expression: { operand: [{ localId: "2", locator: "1:1" }] } }] } } });
  assert.equal(stripped.library.localId, "0");
  assert.equal(stripped.library.statements.def[0]!.localId, "1");
  assert.deepEqual(stripped.library.statements.def[0]!.expression.operand[0], { localId: "2" });
});

test("the strip is a byte-for-byte no-op on every committed official cms137 library (they carry none of the three keys)", () => {
  const libraries = librariesOf(baseBundle);
  assert.equal(libraries.length, 7);
  for (const library of libraries) {
    const data = elmDataOf(library);
    assert.equal(encodeElm(stripElmDebugKeys(decode(data))), data, `${String(library["name"])} re-encodes to its committed bytes`);
  }
});

// ---- the bundle -----------------------------------------------------------------------------------------

/** CMS's main-library ELM with the keys a fresh compile carries, standing in for our compile. */
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
  assert.ok(!/"(annotation|locator)":/.test(JSON.stringify(elm)), "the compiled ELM's CQL text and positions are stripped");
  assert.equal(elm.library.statements.def[0].localId, "9", "and its localIds are kept");
  assert.deepEqual(elm.library.identifier, { id: IDENTITY.name, version: IDENTITY.version });
});

test("the assembler refuses ELM that is not the main library's, and a base carrying anything but a Measure and Libraries", () => {
  const other = decode(elmDataOf(librariesOf(baseBundle).find((l) => l["name"] === "Hospice")!));
  assert.throws(() => assembleTranslationBundle(baseBundle, other, IDENTITY), /compiled ELM is Hospice\|6\.18\.000, not the main library CMS137FHIRSUDTxInitEngagement\|1\.0\.000/);
  const withValueSet = { entry: [...baseBundle.entry, { resource: { resourceType: "ValueSet", id: "vs" } }] };
  assert.throws(() => assembleTranslationBundle(withValueSet, compiledMainElm(), IDENTITY), /carries ValueSet; a translation holds only a Measure and its Libraries/);
});

// ---- a changed library (#779) ---------------------------------------------------------------------------

// The committed official cms130 artifact: its AdvancedIllnessandFrailty is included by the main library alone.
const cms130 = loadOfficialArtifact("cms130")!;
const cms130Bundle = cms130.bundle as unknown as B;
const IDENTITY_130 = translationIdentity("cms130", 2027, "CMS130v15");
const AIF = "AdvancedIllnessandFrailty";
const AIF_WW = "WorkWellAdvancedIllnessandFrailtyTranslation2027";
const cmsAif = librariesOf(cms130Bundle).find((l) => l["name"] === AIF)!;
/** CMS's ELM for a cms130 library with the keys a fresh compile carries, and a mark that it is OURS. */
function compiled130(name: string) {
  const elm = decode(elmDataOf(librariesOf(cms130Bundle).find((l) => l["name"] === name)!));
  elm.library.annotation = [{ type: "CqlToElmInfo", translatorOptions: "EnableAnnotations", signatureLevel: "All" }];
  elm.library.statements.def[0].localId = "7";
  elm.library.statements.def[0].locator = "1:1-1:9";
  elm.library.oursForTheTest = true;
  return elm;
}
const changedAif = { from: { name: AIF, version: "1.27.000" }, compiledElm: compiled130(AIF), translationSha256: `sha256:${"e".repeat(64)}` };

test("a changed library is OUR compile under WorkWell's identity, pinned to CMS's ELM it came from, and never also listed as unchanged", () => {
  const before = JSON.stringify(cms130Bundle);
  const { bundle, unchangedLibraries, changedLibraries } = assembleTranslationBundle(cms130Bundle, compiled130("CMS130FHIRColorectalCancerScrn"), IDENTITY_130, [changedAif]);
  assert.equal(JSON.stringify(cms130Bundle), before, "CMS's committed bundle is not modified");

  assert.deepEqual(changedLibraries, [
    { name: AIF_WW, version: "ww-2027.1", from: { name: AIF, version: "1.27.000", elmSha256: libraryElmSha256(cmsAif) }, translationSha256: changedAif.translationSha256 },
  ]);
  const shared = librariesOf(cms130Bundle).filter((l) => l !== mainOf(cms130Bundle) && l !== cmsAif);
  assert.deepEqual(unchangedLibraries, shared.map((l) => ({ name: String(l["name"]), version: String(l["version"]), elmSha256: libraryElmSha256(l) })));
  for (const library of shared) assert.deepEqual(librariesOf(bundle).find((l) => l["name"] === library["name"]), library, `${String(library["name"])} is carried verbatim`);

  const ours = librariesOf(bundle).find((l) => l["name"] === AIF_WW)!;
  const elm = decode(elmDataOf(ours));
  assert.equal(elm.library.oursForTheTest, true, "the changed library's ELM is ours");
  assert.ok(!/"(annotation|locator)":/.test(JSON.stringify(elm)), "stripped");
  assert.equal(elm.library.statements.def[0].localId, "7");
  const include = decode(elmDataOf(mainOf(bundle))).library.includes.def.find((d: { localIdentifier: string }) => d.localIdentifier === "AIFrailLTCF");
  assert.deepEqual(include, { localIdentifier: "AIFrailLTCF", path: AIF_WW, version: "ww-2027.1" });

  // With no changed library, the assembly is exactly the one CMS137 has always had.
  const plain = assembleTranslationBundle(baseBundle, compiledMainElm(), IDENTITY);
  assert.deepEqual(assembleTranslationBundle(baseBundle, compiledMainElm(), IDENTITY, []), plain);
  assert.deepEqual(plain.changedLibraries, []);
});

test("the assembler refuses a changed library that is the main one, is not in CMS's bundle, or is listed twice", () => {
  const main130 = compiled130("CMS130FHIRColorectalCancerScrn");
  assert.throws(
    () => assembleTranslationBundle(cms130Bundle, main130, IDENTITY_130, [{ ...changedAif, from: { name: "CMS130FHIRColorectalCancerScrn", version: "1.0.000" } }]),
    /the edited library CMS130FHIRColorectalCancerScrn 1\.0\.000 is the main library, which is renamed with the Measure/,
  );
  assert.throws(
    () => assembleTranslationBundle(cms130Bundle, main130, IDENTITY_130, [{ ...changedAif, from: { name: AIF, version: "1.26.000" } }]),
    /the edited library AdvancedIllnessandFrailty 1\.26\.000 is not a shared library of CMS's committed bundle/,
  );
  assert.throws(() => assembleTranslationBundle(cms130Bundle, main130, IDENTITY_130, [changedAif, changedAif]), /a changed library is listed twice/);
  // The ELM must be the edited library's: rewriteChangedLibrary checks the slot.
  assert.throws(
    () => assembleTranslationBundle(cms130Bundle, main130, IDENTITY_130, [{ ...changedAif, compiledElm: compiled130("Hospice") }]),
    /the compiled ELM is Hospice\|6\.18\.000, not AdvancedIllnessandFrailty\|1\.27\.000/,
  );
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

test("changedLibraries is written after unchangedLibraries and before oracles, and not at all when there is none", () => {
  const entry = { name: AIF_WW, version: "ww-2027.1", from: { name: AIF, version: "1.27.000", elmSha256: `sha256:${"f".repeat(64)}` }, translationSha256: `sha256:${"e".repeat(64)}` };
  const input = { base: cms137, bundleJson, identity: IDENTITY, build: BUILD, unchangedLibraries: assembled.unchangedLibraries, packageSha256: `sha256:${"a".repeat(64)}`, terminologyBlock: TERMINOLOGY };
  const withChanged = derivedManifestFor({ ...input, changedLibraries: [entry] }).manifest.derived!;
  assert.deepEqual(Object.keys(withChanged), ["label", "derivedFrom", "base", "build", "unchangedLibraries", "changedLibraries", "oracles"]);
  assert.deepEqual(withChanged.changedLibraries, [entry]);
  // None (the CMS137 case): the key is absent, so its committed manifest is byte-for-byte what it was.
  for (const changedLibraries of [undefined, []]) {
    const derived = derivedManifestFor({ ...input, ...(changedLibraries ? { changedLibraries } : {}) }).manifest.derived!;
    assert.deepEqual(Object.keys(derived), ["label", "derivedFrom", "base", "build", "unchangedLibraries", "oracles"]);
  }
  assert.equal(`${JSON.stringify(derivedManifestFor({ ...input, changedLibraries: [] }).manifest, null, 2)}\n`, `${JSON.stringify(manifestFor(null).manifest, null, 2)}\n`);
});

// ---- data requirements recomputed where the reads changed (#782) ----------------------------------------

const cms125 = loadOfficialArtifact("cms125")!;
const cms125Bundle = cms125.bundle as unknown as B;
const IDENTITY_125 = translationIdentity("cms125", 2027, "CMS125v15");
const VS_1071 = "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.198.12.1071";
/** CMS's cms125 main ELM with the unspecified-laterality diagnosis branches and their value set removed. */
function without1071() {
  const elm = decode(elmDataOf(mainOf(cms125Bundle)));
  const unspecified = "Unilateral Mastectomy, Unspecified Laterality";
  elm.library.valueSets.def = elm.library.valueSets.def.filter((d: { name: string }) => d.name !== unspecified);
  for (const side of ["Left", "Right"]) {
    const verified = elm.library.statements.def.find((d: { name: string }) => d.name === `${side} Mastectomy Diagnosis`).expression.source[0].expression;
    verified.operand[0] = verified.operand[0].operand.find((o: unknown) => !JSON.stringify(o).includes(unspecified));
  }
  return elm;
}
const valueSetsNamed = (library: Res) =>
  new Set([
    ...((library["relatedArtifact"] as Res[] | undefined) ?? []).map((r) => String(r["resource"])).filter((r) => r.includes("ValueSet")),
    ...((library["dataRequirement"] as Array<{ codeFilter?: Res[] }> | undefined) ?? []).flatMap((d) => (d.codeFilter ?? []).map((f) => String(f["valueSet"]))),
  ]);

test("a main library whose reads changed carries recomputed lists and is named; its shared libraries and an unchanged build are untouched", () => {
  const plain = assembleTranslationBundle(cms125Bundle, decode(elmDataOf(mainOf(cms125Bundle))), IDENTITY_125);
  assert.deepEqual(plain.recomputedDataRequirements, [], "an unedited main library reads what CMS's reads: nothing is recomputed");
  assert.deepEqual(mainOf(plain.bundle)["dataRequirement"], mainOf(cms125Bundle)["dataRequirement"], "and CMS's lists are carried as they are");
  assert.deepEqual(assembleTranslationBundle(baseBundle, compiledMainElm(), IDENTITY).recomputedDataRequirements, []);

  const { bundle, recomputedDataRequirements } = assembleTranslationBundle(cms125Bundle, without1071(), IDENTITY_125);
  assert.deepEqual(recomputedDataRequirements, ["WorkWellCMS125Translation2027"]);
  const main = mainOf(bundle);
  assert.ok(valueSetsNamed(mainOf(cms125Bundle)).has(VS_1071));
  assert.ok(!valueSetsNamed(main).has(VS_1071), "no list still names the value set the ELM no longer declares");
  const declared = decode(elmDataOf(main)).library.valueSets.def.map((d: { id: string }) => d.id).sort();
  assert.deepEqual([...valueSetsNamed(main)].sort(), declared);
  assert.equal((main["dataRequirement"] as unknown[]).length, (mainOf(cms125Bundle)["dataRequirement"] as unknown[]).length - 4, "the four 1071 retrieves' entries are gone");
  // Identity first, then the lists: the recompute is on the renamed library, and the Measure is untouched.
  assert.equal(main["name"], IDENTITY_125.name);
  assert.deepEqual(measureOf(bundle), measureOf(plain.bundle));
  const cmsMain = String(mainOf(cms125Bundle)["name"]);
  for (const library of librariesOf(cms125Bundle).filter((l) => l["name"] !== cmsMain)) {
    assert.deepEqual(librariesOf(bundle).find((l) => l["name"] === library["name"]), library, `${String(library["name"])} is carried verbatim`);
  }
});

test("a changed library whose reads changed is recomputed against CMS's ELM for the library it was edited from", () => {
  const aif = compiled130(AIF);
  let swapped = false;
  const swap = (node: unknown): void => {
    if (swapped || !node || typeof node !== "object") return;
    const n = node as Record<string, { type?: string; name?: string } | unknown>;
    const codes = n["codes"] as { type?: string; name?: string } | undefined;
    if (n["type"] === "Retrieve" && codes?.type === "ValueSetRef" && codes.name === "Advanced Illness") {
      n["codes"] = { ...codes, name: "Frailty Diagnosis" };
      swapped = true;
      return;
    }
    for (const value of Object.values(n)) swap(value);
  };
  swap(aif.library.statements);
  assert.ok(swapped);
  const { bundle, recomputedDataRequirements } = assembleTranslationBundle(cms130Bundle, compiled130("CMS130FHIRColorectalCancerScrn"), IDENTITY_130, [{ ...changedAif, compiledElm: aif }]);
  assert.deepEqual(recomputedDataRequirements, [AIF_WW], "the main library reads what CMS's does, so only the changed one is named");
  const entriesFor = (library: Res, oid: string) => (library["dataRequirement"] as Res[]).filter((d) => JSON.stringify(d).includes(oid)).length;
  const ours = librariesOf(bundle).find((l) => l["name"] === AIF_WW)!;
  const ADVANCED_ILLNESS = "113883.3.464.1003.110.12.1082";
  const FRAILTY_DIAGNOSIS = "113883.3.464.1003.113.12.1074";
  assert.equal(entriesFor(ours, ADVANCED_ILLNESS), entriesFor(cmsAif, ADVANCED_ILLNESS) - 1);
  assert.equal(entriesFor(ours, FRAILTY_DIAGNOSIS), entriesFor(cmsAif, FRAILTY_DIAGNOSIS) + 1);
  assert.deepEqual(ours["relatedArtifact"], cmsAif["relatedArtifact"], "the same value sets are declared, so the depends-on entries are CMS's");
});

test("recomputedDataRequirements is written after changedLibraries and before oracles, and not at all when there is none", () => {
  const entry = { name: AIF_WW, version: "ww-2027.1", from: { name: AIF, version: "1.27.000", elmSha256: `sha256:${"f".repeat(64)}` }, translationSha256: `sha256:${"e".repeat(64)}` };
  const input = { base: cms137, bundleJson, identity: IDENTITY, build: BUILD, unchangedLibraries: assembled.unchangedLibraries, packageSha256: `sha256:${"a".repeat(64)}`, terminologyBlock: TERMINOLOGY };
  const both = derivedManifestFor({ ...input, changedLibraries: [entry], recomputedDataRequirements: [AIF_WW, IDENTITY.name] }).manifest.derived!;
  assert.deepEqual(Object.keys(both), ["label", "derivedFrom", "base", "build", "unchangedLibraries", "changedLibraries", "recomputedDataRequirements", "oracles"]);
  assert.deepEqual(both.recomputedDataRequirements, [AIF_WW, IDENTITY.name]);
  const mainOnly = derivedManifestFor({ ...input, recomputedDataRequirements: [IDENTITY.name] }).manifest.derived!;
  assert.deepEqual(Object.keys(mainOnly), ["label", "derivedFrom", "base", "build", "unchangedLibraries", "recomputedDataRequirements", "oracles"]);
  for (const recomputedDataRequirements of [undefined, []]) {
    const derived = derivedManifestFor({ ...input, ...(recomputedDataRequirements ? { recomputedDataRequirements } : {}) }).manifest.derived!;
    assert.deepEqual(Object.keys(derived), ["label", "derivedFrom", "base", "build", "unchangedLibraries", "oracles"]);
  }
});
