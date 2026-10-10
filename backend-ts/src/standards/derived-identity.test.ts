/**
 * A translation carries WorkWell's identity and no CMS one (LOCKED §4.3). The validator is what the
 * router runs before routing one, so every way of getting the identity wrong must produce a sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CMS130_CHANGED, CMS130_CHANGED_FROM, derivedCms130Changed, derivedCms137, FIXTURE_URL } from "../test-support/derived-fixture.ts";
import { loadDerivedArtifact, loadOfficialArtifact, type OfficialManifest } from "../wiring/official-artifacts.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  bundleDataRequirementProblems,
  derivedIdentityProblems,
  installedTranslatorVersion,
  libraryDataRequirementProblems,
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
const fixture = derivedCms137();
const clone = () => JSON.parse(JSON.stringify(fixture.bundle)) as B;
/** The verdict is memoized per object, so a bundle edited after a check is re-checked as a fresh copy. */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const measureIn = (b: B) => b.entry.find((e) => e.resource.resourceType === "Measure")!.resource;
const mainIn = (b: B) => {
  const url = (measureIn(b)["library"] as string[])[0];
  return b.entry.find((e) => e.resource["url"] === url)!.resource;
};
const libraryIn = (b: B, name: string) => b.entry.find((e) => e.resource.resourceType === "Library" && e.resource["name"] === name)!.resource;
const elmOf = (library: Res) => {
  const content = (library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  return {
    elm: JSON.parse(Buffer.from(content.data, "base64").toString("utf8")),
    save: (elm: unknown) => (content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64")),
  };
};
const cms137 = loadOfficialArtifact("cms137")!;
const cmsMeasure = (cms137.bundle as unknown as B).entry.find((e) => e.resource.resourceType === "Measure")!.resource;
const problems = (bundle: unknown, manifest = fixture.manifest, base: typeof cms137 | null = cms137) => derivedIdentityProblems(bundle as never, manifest, base);
const expect = (list: readonly string[], pattern: RegExp) => assert.ok(list.some((p) => pattern.test(p)), `expected ${pattern} in ${JSON.stringify(list)}`);
const derivedWith = (patch: Partial<NonNullable<OfficialManifest["derived"]>>): OfficialManifest => ({ ...fixture.manifest, derived: { ...fixture.manifest.derived!, ...patch } });
const buildWith = (patch: Partial<NonNullable<OfficialManifest["derived"]>["build"]>): OfficialManifest =>
  derivedWith({ build: { ...fixture.manifest.derived!.build, ...patch } });

test("the rewritten committed CMS137 bundle is a valid translation identity", () => {
  assert.deepEqual(problems(fixture.bundle), []);
  const measure = measureIn(clone());
  assert.equal(measure["url"], FIXTURE_URL);
  assert.equal(measure["status"], "draft");
  assert.deepEqual(measure["identifier"], []);
  assert.ok((measure["relatedArtifact"] as Array<Record<string, unknown>>).some((r) => r["type"] === "derived-from" && r["display"] === "CMS137v15"));
});

test("CMS's own bundle, unrewritten, is refused on every count", () => {
  const cms = loadOfficialArtifact("cms137")!;
  const list = problems(cms.bundle, { ...fixture.manifest });
  expect(list, /not a WorkWell canonical/);
  expect(list, /status draft/);
  expect(list, /not a ww- version/);
  expect(list, /CMS '.+' identifier/);
  expect(list, /names madie\.cms\.gov/);
  expect(list, /no derived-from link/);
});

test("each identity fault produces its own sentence", () => {
  let b = clone();
  measureIn(b)["identifier"] = [{ type: { coding: [{ code: "version-specific" }] }, value: "urn:uuid:abc" }];
  expect(problems(b), /CMS 'version-specific' identifier/);
  expect(problems(b), /CMS UUID identifier/);

  b = clone();
  measureIn(b)["relatedArtifact"] = [];
  expect(problems(b), /no derived-from link/);

  b = clone();
  measureIn(b)["publisher"] = "https://madie.cms.gov";
  expect(problems(b), /publisher still names madie\.cms\.gov/);

  b = clone();
  mainIn(b)["url"] = "https://madie.cms.gov/Library/CMS137FHIR";
  expect(problems(b), /changed library .+ not a WorkWell library canonical/);

  expect(problems(fixture.bundle, { ...fixture.manifest, cmsId: "137FHIR" }), /cmsId null/);
  expect(problems(fixture.bundle, { ...fixture.manifest, version: "ww-2027.2" }), /manifest version/);
  const { derived: _omit, ...noBlock } = fixture.manifest;
  expect(problems(fixture.bundle, noBlock as never), /no derived block/);
});

test("'unchanged' is checked against CMS's own library, not against the translation's word for it", () => {
  // The builder re-pinned an edited Hospice, as a builder that hashes its own output would.
  const b = clone();
  const library = b.entry.find((e) => e.resource.resourceType === "Library" && e.resource["name"] === "Hospice")!.resource;
  const content = (library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8"));
  elm.library.statements.def.pop();
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
  const repinned = {
    ...fixture.manifest,
    derived: {
      ...fixture.manifest.derived!,
      unchangedLibraries: fixture.manifest.derived!.unchangedLibraries.map((l) =>
        l.name === "Hospice" ? { ...l, elmSha256: `sha256:${createHash("sha256").update(Buffer.from(content.data, "base64")).digest("hex")}` } : l,
      ),
    },
  };
  expect(problems(b, repinned), /Hospice\|.+ keeps CMS's identity but its ELM is not CMS's/);
});

test("the translation must be built on the committed CMS artifact, and needs it to check anything", () => {
  expect(problems(fixture.bundle, { ...fixture.manifest, derived: { ...fixture.manifest.derived!, base: { catalogId: "cms137", manifestSha256: "sha256:stale" } } }), /built on CMS's artifact sha256:stale/);
  expect(problems(fixture.bundle, fixture.manifest, null), /CMS's artifact for this measure is not committed/);
});

test("an 'unchanged' CMS library whose ELM was in fact changed is caught by its pin", () => {
  const b = clone();
  const library = b.entry.find((e) => e.resource.resourceType === "Library" && e.resource["name"] === "Hospice")!.resource;
  const content = (library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8"));
  elm.library.statements.def.pop();
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
  expect(problems(b), /Hospice\|.+ is listed as unchanged but its ELM does not match its pin/);
});

test("a library WorkWell changed carries WorkWell identity in every field, not just a WorkWell url", () => {
  // Hospice, edited and therefore no longer listed as unchanged, given only a WorkWell url.
  const b = clone();
  const hospice = b.entry.find((e) => e.resource.resourceType === "Library" && e.resource["name"] === "Hospice")!.resource;
  const cmsVersion = String(hospice["version"]);
  hospice["url"] = "urn:workwell:library:Hospice";
  const notUnchanged = {
    ...fixture.manifest,
    derived: { ...fixture.manifest.derived!, unchangedLibraries: fixture.manifest.derived!.unchangedLibraries.filter((l) => l.name !== "Hospice") },
  };
  const kept = problems(b, notUnchanged);
  expect(kept, /changed library Hospice\|.+ keeps CMS's library name 'Hospice'/);
  expect(kept, /changed library Hospice\|.+ has version '.+', not a ww- version/);

  // Renamed and re-versioned on the resource, but the ELM inside still identifies itself as CMS's library.
  hospice["name"] = "WorkWellHospice2027";
  hospice["version"] = "ww-2027.1";
  const renamed = problems(fresh(b), notUnchanged);
  const sentence = `changed library WorkWellHospice2027|ww-2027.1's ELM is identified as 'Hospice|${cmsVersion}'`;
  assert.ok(renamed.some((p) => p.includes(sentence)), `expected "${sentence}" in ${JSON.stringify(renamed)}`);
  assert.ok(!renamed.some((p) => /keeps CMS's library name|not a ww- version/.test(p)), JSON.stringify(renamed));

  // Identified as itself all the way down: nothing left to refuse about that library's identity FIELDS.
  // (A hand-renamed library is still unreachable, unrecorded and carries CMS's resource identifier; those
  // rules are tested on the CMS130 fixture, where a changed library is built the way the builder builds one.)
  const content = (hospice["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8"));
  elm.library.identifier = { id: "WorkWellHospice2027", version: "ww-2027.1" };
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
  const fieldRules = /changed library WorkWellHospice2027\|ww-2027\.1 (has url|keeps CMS's library name|has version|has no ELM identifier|still names)|WorkWellHospice2027\|ww-2027\.1's ELM is identified as/;
  assert.deepEqual(problems(fresh(b), notUnchanged).filter((p) => fieldRules.test(p)), []);

  // A changed library with no ELM cannot be checked, so it is refused.
  hospice["content"] = [];
  expect(problems(fresh(b), notUnchanged), /WorkWellHospice2027\|ww-2027\.1 has no ELM identifier to check/);
});

test("CMS's host is refused in any letter case: the check is a refusal, not a URL parser", () => {
  const b = clone();
  measureIn(b)["publisher"] = "MADiE.CMS.gov";
  expect(problems(b), /publisher still names madie\.cms\.gov/);
});

// ---- the rewrite reaches the identity no reader names a field for -------------------------------------

test("the rewrite renames both resource ids and drops the contained Library that carries CMS's canonical", () => {
  const cms = cms137.bundle as unknown as B;
  const cmsMain = mainIn(cms);
  // Non-vacuous: CMS's Measure does carry the contained Library and the extension pointing at it.
  assert.ok((cmsMeasure["contained"] as Res[]).some((r) => r["id"] === "effective-data-requirements"));
  assert.ok((cmsMeasure["extension"] as Array<Record<string, unknown>>).some((e) => e["valueCanonical"] === "#effective-data-requirements"));

  const b = clone();
  const measure = measureIn(b);
  const main = mainIn(b);
  assert.equal(measure["id"], "WorkWellCMS137Translation2027");
  assert.equal(main["id"], "WorkWellCMS137Translation2027");
  assert.equal(main["description"], "WorkWell translation of CMS137v15", "CMS describes its main library by its bare measure name");
  assert.equal(main["publisher"], "WorkWell");
  assert.ok(!(measure["contained"] as Res[] | undefined)?.some((r) => r["id"] === "effective-data-requirements"));
  assert.ok(!JSON.stringify(measure["extension"] ?? []).includes("#effective-data-requirements"), "no extension may point at the removed Library");
  assert.equal((measure["extension"] as unknown[]).length, (cmsMeasure["extension"] as unknown[]).length - 1, "only the extension that pointed at it is removed");
  // Kept: the profiles a reader validates against.
  assert.deepEqual(measure["meta"], cmsMeasure["meta"]);
  assert.deepEqual(main["meta"], cmsMain["meta"]);
});

test("the rewrite drops what states CMS's publication: the bundle's name, the usage text, the dates, CMS's compile options", () => {
  const cms = cms137.bundle as unknown as B & { id?: unknown };
  const cmsMain = mainIn(cms);
  // Non-vacuous: CMS's bundle carries every one of them.
  assert.equal(cms.id, `${String(cmsMeasure["id"])}-bundle`);
  assert.ok(typeof cmsMeasure["usage"] === "string" && typeof cmsMeasure["date"] === "string" && typeof cmsMain["date"] === "string");
  assert.ok((cmsMain["contained"] as Res[]).some((r) => r.resourceType === "Parameters" && r["id"] === "options"));
  assert.ok((cmsMain["extension"] as Array<Record<string, unknown>>).some((e) => (e["valueReference"] as { reference?: string } | undefined)?.reference === "#options"));

  const b = clone() as B & { id?: unknown };
  const measure = measureIn(b);
  const main = mainIn(b);
  assert.equal(b.id, "WorkWellCMS137Translation2027-bundle");
  assert.equal(measure["usage"], undefined, "CMS's usage text names the QDM measure CMS's draft was derived from");
  assert.equal(measure["date"], undefined);
  assert.equal(main["date"], undefined);
  // CMS's compile was translator 3.27.0 with annotations and locators on; this ELM is WorkWell's, stripped.
  assert.equal(main["contained"], undefined, "the options Parameters was the main library's only contained resource");
  assert.equal(main["extension"], undefined, "and the cqf-cqlOptions extension pointing at it goes with it");
  // The six libraries carried unchanged keep CMS's record of CMS's compile: it is true of their ELM.
  for (const library of b.entry.filter((e) => e.resource.resourceType === "Library" && e.resource !== main)) {
    assert.deepEqual(library.resource["contained"], libraryIn(cms, String(library.resource["name"]))["contained"]);
  }
});

test("CMS's identity anywhere in the Measure or the main library is refused, not only in the named fields", () => {
  const cmsId = String(cmsMeasure["id"]);
  let b = clone();
  measureIn(b)["id"] = cmsId;
  expect(problems(b), new RegExp(`translated Measure still carries CMS's identity in 1 place\\(s\\): Measure\\.id '${cmsId}'`));

  // The contained Library put back: CMS's host and name, nested where no field check looks.
  b = clone();
  measureIn(b)["contained"] = cmsMeasure["contained"];
  expect(problems(b), /translated Measure still carries CMS's identity in \d+ place\(s\): Measure\.contained\[0\]/);

  // CMS's measure url, deep in a group, and in another letter case.
  b = clone();
  ((measureIn(b)["group"] as Array<Record<string, unknown>>)[0]!)["description"] = `see ${String(cmsMeasure["url"]).toUpperCase()}`;
  expect(problems(b), /translated Measure still carries CMS's identity in 1 place\(s\): Measure\.group\[0\]\.description/);

  // The main library described by CMS's bare measure name (what CMS ships), or by CMS's main-library url.
  b = clone();
  mainIn(b)["description"] = cmsId;
  expect(problems(b), new RegExp(`translated main library still carries CMS's identity in 1 place\\(s\\): Library\\.description '${cmsId}'`));
  b = clone();
  mainIn(b)["description"] = `${String(mainIn(cms137.bundle as unknown as B)["url"])}|1.0.000`;
  expect(problems(b), /translated main library still carries CMS's identity in 1 place\(s\): Library\.description/);
});

test("CMS's canonicals are refused for themselves, not only because they name CMS's host", () => {
  // A base whose Measure and main library live elsewhere: only the url needles can catch them.
  const elsewhere = fresh(cms137.bundle as unknown as B);
  const measure = measureIn(elsewhere);
  const main = mainIn(elsewhere);
  measure["url"] = "https://example.org/Measure/Elsewhere";
  main["url"] = "https://example.org/Library/Elsewhere";
  measure["library"] = ["https://example.org/Library/Elsewhere"];
  const base = { ...cms137, bundle: elsewhere as never };
  let b = clone();
  measureIn(b)["description"] = "the base is https://example.org/Measure/Elsewhere";
  expect(problems(b, fixture.manifest, base), /translated Measure still carries CMS's identity in 1 place\(s\): Measure\.description/);
  b = clone();
  mainIn(b)["description"] = "https://example.org/Library/Elsewhere|1.0.000";
  expect(problems(b, fixture.manifest, base), /translated main library still carries CMS's identity in 1 place\(s\): Library\.description/);
  assert.deepEqual(problems(fixture.bundle, fixture.manifest, base), [], "and the fixture names neither");
});

test("the Bundle's own id and identifier are scanned, and CMS's names are needles read from CMS's manifest", () => {
  type WithOwn = B & { id?: unknown; identifier?: unknown };
  const shortName = `CMS${String(cms137.manifest.cmsId)}`;
  assert.equal(shortName, "CMS137FHIR", "sanity: the short name is CMS's manifest's cmsId");
  let b = clone() as WithOwn;
  b.id = `${String(cmsMeasure["id"])}-bundle`;
  expect(problems(b), new RegExp(`translated Bundle still carries CMS's identity in 1 place\\(s\\): Bundle\\.id '${String(cmsMeasure["id"])}-bundle'`));
  b = clone() as WithOwn;
  b.identifier = { system: "urn:ietf:rfc:3986", value: `urn:cms:${cms137.manifest.measureName}` };
  expect(problems(b), /translated Bundle still carries CMS's identity in 1 place\(s\): Bundle\.identifier\.value/);

  // The short name alone, where no canonical, host or measure id is: in the Measure, and in the main library.
  b = clone();
  measureIn(b)["description"] = `Formerly ${shortName}.`;
  expect(problems(b), /translated Measure still carries CMS's identity in 1 place\(s\): Measure\.description 'Formerly CMS137FHIR\.'/);
  b = clone();
  mainIn(b)["purpose"] = `the ${shortName.toLowerCase()} logic`;
  expect(problems(b), /translated main library still carries CMS's identity in 1 place\(s\): Library\.purpose/);

  // Read from the base manifest, not written into the check: a base naming another measure brings its own
  // needles, and CMS137's short name alone is then no longer one.
  const other = { ...cms137, manifest: { ...cms137.manifest, cmsId: "999FHIR", measureName: "ElsewhereScreening" } };
  b = clone();
  measureIn(b)["description"] = "Formerly CMS999FHIR.";
  expect(problems(b, fixture.manifest, other), /translated Measure still carries CMS's identity in 1 place\(s\): Measure\.description 'Formerly CMS999FHIR\.'/);
  b = clone();
  measureIn(b)["description"] = "see elsewherescreening";
  expect(problems(b, fixture.manifest, other), /translated Measure still carries CMS's identity in 1 place\(s\): Measure\.description 'see elsewherescreening'/);
  b = clone();
  measureIn(b)["description"] = `Formerly ${shortName}.`;
  assert.deepEqual(problems(b, fixture.manifest, other), []);
  assert.deepEqual(problems(fixture.bundle, fixture.manifest, other), [], "and the fixture names neither");
});

test("the label every screen shows is tied to its own form, the Measure's title and the CMS measure it derives from", () => {
  const withLabel = (label: string, ecqm = "CMS137v15") => derivedWith({ label, derivedFrom: { ...fixture.manifest.derived!.derivedFrom, ecqm } });
  // The fixture's verdict is memoized first: a relabelled manifest declaring the same hash must not be served it.
  assert.deepEqual(problems(fixture.bundle), []);
  assert.equal(withLabel("CMS137v15").sha256, fixture.manifest.sha256);

  // The relabel §4.3 forbids: CMS's measure name as the label, everything else honest.
  let list = problems(fixture.bundle, withLabel("CMS137v15"));
  expect(list, /the translation's label 'CMS137v15' is not 'WorkWell translation of CMS137v15'; the label is what every screen names the logic by/);
  expect(list, /the translation's label 'CMS137v15' is not the translated Measure's title 'WorkWell translation of CMS137v15'/);

  // Relabelled consistently inside the manifest, it still disagrees with the bundle it describes.
  list = problems(fixture.bundle, withLabel("WorkWell translation of CMS999v1", "CMS999v1"));
  expect(list, /label 'WorkWell translation of CMS999v1' is not the translated Measure's title 'WorkWell translation of CMS137v15'/);
  expect(list, /derived-from link names 'CMS137v15', but the manifest says it is derived from 'CMS999v1'/);
  assert.ok(!list.some((p) => p.includes("is not 'WorkWell translation of CMS999v1';")), "its own form is right");
  expect(problems(fixture.bundle, withLabel("", "")), /derivedFrom\.ecqm '' does not name the CMS measure/);

  // The bundle edited instead: the title, or the derived-from link, or a second link naming another source.
  let b = clone();
  measureIn(b)["title"] = "CMS137v15";
  expect(problems(b), /label 'WorkWell translation of CMS137v15' is not the translated Measure's title 'CMS137v15'/);
  const relink = (map: (links: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) => {
    const edited = clone();
    measureIn(edited)["relatedArtifact"] = map(measureIn(edited)["relatedArtifact"] as Array<Record<string, unknown>>);
    return edited;
  };
  b = relink((links) => links.map((r) => (r["type"] === "derived-from" ? { ...r, display: "CMS137v14" } : r)));
  expect(problems(b), /derived-from link names 'CMS137v14', but the manifest says it is derived from 'CMS137v15'/);
  b = relink((links) => [...links, { type: "derived-from", display: "CMS137v14" }]);
  expect(problems(b), /derived-from link names 'CMS137v14'/);
});

test("a Measure whose library is not in the bundle is refused", () => {
  const b = clone();
  measureIn(b)["library"] = ["urn:workwell:library:Nowhere"];
  expect(problems(b), /translated Measure's library 'urn:workwell:library:Nowhere' names no library in the bundle/);
});

test("a main-library depends-on may name a library carried unchanged under CMS's canonical, and nothing else may", () => {
  const unchangedFhirHelpers = "https://madie.cms.gov/Library/FHIRHelpers|4.4.000";
  // Non-vacuous: the fixture passes WITH such entries in it.
  assert.ok((mainIn(clone())["relatedArtifact"] as Array<Record<string, unknown>>).some((r) => r["type"] === "depends-on" && r["resource"] === unchangedFhirHelpers));
  assert.deepEqual(problems(fixture.bundle), []);

  const withRelated = (on: "main" | "measure", entry: Record<string, unknown>) => {
    const b = clone();
    const resource = on === "main" ? mainIn(b) : measureIn(b);
    resource["relatedArtifact"] = [...((resource["relatedArtifact"] as unknown[]) ?? []), entry];
    return b;
  };
  const cmsMainCanonical = `${String(mainIn(cms137.bundle as unknown as B)["url"])}|1.0.000`;
  expect(problems(withRelated("main", { type: "depends-on", resource: cmsMainCanonical })), /main library still carries CMS's identity .*relatedArtifact\[\d+\]\.resource/);
  expect(problems(withRelated("main", { type: "composed-of", resource: unchangedFhirHelpers })), /main library still carries CMS's identity .*relatedArtifact\[\d+\]\.resource/);
  // Only the `resource` of an exempt entry is exempt: CMS's identity elsewhere in the same entry is not.
  expect(problems(withRelated("main", { type: "depends-on", resource: unchangedFhirHelpers, display: unchangedFhirHelpers })), /main library still carries CMS's identity in 1 place\(s\): Library\.relatedArtifact\[\d+\]\.display/);
  expect(problems(withRelated("measure", { type: "depends-on", resource: unchangedFhirHelpers })), /translated Measure still carries CMS's identity .*Measure\.relatedArtifact\[\d+\]\.resource/);
});

// ---- the manifest's own record ----------------------------------------------------------------------

test("the manifest names the Measure, carries no CMS deck, and records the build this worker can trust", () => {
  expect(problems(fixture.bundle, { ...fixture.manifest, measureName: String(cmsMeasure["name"]) }), /manifest's measureName 'CMS137FHIRSUDTxInitEngagement' is not the translated Measure's name 'WorkWellCMS137Translation2027'/);
  expect(problems(fixture.bundle, { ...fixture.manifest, tests: cms137.manifest.tests }), /carries no tests block/);
  expect(problems(fixture.bundle, buildWith({ modelInfoSha256: "sha256:75cf34cc" })), /compiled against model info sha256:75cf34cc, not the pinned QICore 6\.0\.0/);
  expect(problems(fixture.bundle, derivedWith({ derivedFrom: { ecqm: "CMS137v15", packageSha256: "sha256:p" } })), /derivedFrom\.packageSha256 'sha256:p' is not a sha256/);
  expect(problems(fixture.bundle, buildWith({ translationSha256: `sha256:${"B".repeat(64)}` })), /build\.translationSha256 .* is not a sha256/);
  expect(problems(fixture.bundle, buildWith({ translationSha256: `sha256:${"b".repeat(63)}` })), /build\.translationSha256 .* is not a sha256/);

  // A hand-edited manifest missing whole blocks is refused in sentences; the router never throws on it.
  const hollow = { ...fixture.manifest, derived: { label: "x", oracles: [] } as never };
  let list: readonly string[] = [];
  assert.doesNotThrow(() => (list = problems(fixture.bundle, hollow)));
  expect(list, /compiled against model info undefined/);
  expect(list, /derivedFrom\.packageSha256 'undefined' is not a sha256/);
  expect(list, /built on CMS's artifact undefined/);
});

test("the translator that compiled it must be the one installed here", () => {
  const onDisk = JSON.parse(readFileSync(new URL("../../node_modules/@cqframework/cql/package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(installedTranslatorVersion(), onDisk.version, "the reader finds the installed package's own version");
  assert.equal(fixture.manifest.derived!.build.translator, translatorId(onDisk.version));
  assert.equal(fixture.manifest.derived!.build.modelInfoSha256, `sha256:${QICORE_MODEL_INFO_SHA256}`);

  // Valid under the installed translator, then asked again under another: the memo must not answer for it.
  assert.deepEqual(problems(fixture.bundle), []);
  const other = derivedIdentityProblems(fixture.bundle as never, fixture.manifest, cms137, { installedTranslatorVersion: () => "9.9.9" });
  expect(other, /compiled by @cqframework\/cql@.+, but the installed translator is @cqframework\/cql@9\.9\.9; rebuild it/);
  const unreadable = derivedIdentityProblems(fixture.bundle as never, fixture.manifest, cms137, {
    installedTranslatorVersion: () => {
      throw new Error("not installed");
    },
  });
  expect(unreadable, /installed translator is unreadable: not installed/);
});

test("no library's ELM may carry the keys that hold CMS's CQL text, at any depth; localId is not one", () => {
  // Non-vacuous for the unchanged ones: CMS's committed libraries really are stripped.
  for (const library of (cms137.bundle as unknown as B).entry.filter((e) => e.resource.resourceType === "Library")) {
    assert.ok(!/"(annotation|locator)":/.test(JSON.stringify(elmOf(library.resource).elm)), `${String(library.resource["name"])} is committed stripped`);
  }
  let b = clone();
  let main = elmOf(mainIn(b));
  main.elm.library.annotation = [{ type: "CqlToElmInfo" }];
  main.save(main.elm);
  expect(problems(b), /library WorkWellCMS137Translation2027\|ww-2027\.1's ELM carries elm\.library\.annotation; ELM is committed stripped of annotation and locator/);

  b = clone();
  main = elmOf(mainIn(b));
  main.elm.library.statements.def[0].expression = { ...main.elm.library.statements.def[0].expression, locator: "3:1-3:9" };
  main.save(main.elm);
  expect(problems(b), /WorkWellCMS137Translation2027\|ww-2027\.1's ELM carries elm\.library\.statements\.def\[0\]\.expression\.locator/);

  // A localId is a bare node number, and fqm reads each define's value by it: a translation keeps them.
  b = clone();
  main = elmOf(mainIn(b));
  main.elm.library.statements.def[0].localId = "1";
  main.elm.library.statements.def[0].expression = { ...main.elm.library.statements.def[0].expression, localId: "7" };
  main.save(main.elm);
  assert.deepEqual(problems(b), []);

  b = clone();
  const hospice = elmOf(libraryIn(b, "Hospice"));
  hospice.elm.library.statements.def[0].locator = "1:1-2:2";
  hospice.save(hospice.elm);
  expect(problems(b), /library Hospice\|6\.18\.000's ELM carries elm\.library\.statements\.def\[0\]\.locator/);
});

test("the verdict is computed once per artifact and served only to that artifact", () => {
  const first = problems(fixture.bundle);
  assert.equal(problems(fixture.bundle), first, "a repeated call returns the same verdict object");
  assert.ok(Object.isFrozen(first), "and callers cannot edit the shared verdict");

  // It does not re-read the bundle: the ELM made unreadable after the first call is never touched again.
  const b = clone();
  const verdict = problems(b);
  const content = (mainIn(b)["content"] as Array<Record<string, unknown>>)[0]!;
  Object.defineProperty(content, "data", { get: () => assert.fail("a memoized verdict must not decode the ELM again") });
  assert.equal(problems(b), verdict);

  // A different object declaring the same hashes gets its own verdict, never another artifact's.
  const sameShaOtherName = { ...fixture.manifest, measureName: "Other" };
  assert.equal(sameShaOtherName.sha256, fixture.manifest.sha256);
  expect(problems(fixture.bundle, sameShaOtherName), /measureName 'Other'/);
  const edited = clone();
  measureIn(edited)["id"] = String(cmsMeasure["id"]);
  expect(problems(edited), /Measure\.id/);
  assert.deepEqual(problems(fixture.bundle), [], "and the fixture's own verdict is unchanged by either");
});

// ---- a changed CMS shared library (#779): reachability, accounting, provenance, scan, copyright --------

const fx130 = derivedCms130Changed();
const cms130 = loadOfficialArtifact("cms130")!;
const clone130 = () => fresh(fx130.bundle) as unknown as B;
const problems130 = (bundle: unknown, manifest: OfficialManifest = fx130.manifest) => derivedIdentityProblems(bundle as never, manifest, cms130);
const derived130With = (patch: Partial<NonNullable<OfficialManifest["derived"]>>): OfficialManifest => ({ ...fx130.manifest, derived: { ...fx130.manifest.derived!, ...patch } });
const changedEntry = fx130.manifest.derived!.changedLibraries![0]!;
type ChangedEntry = typeof changedEntry;
const withChanged = (map: (entry: ChangedEntry) => unknown) => derived130With({ changedLibraries: [map(changedEntry) as ChangedEntry] });
const CHANGED_KEY = `${CMS130_CHANGED.name}|${CMS130_CHANGED.version}`;
const FROM_KEY = `${CMS130_CHANGED_FROM.name}|${CMS130_CHANGED_FROM.version}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The main library's include of the changed library, to edit in place; `save()` writes the ELM back. */
const aifInclude = (b: B) => {
  const main = elmOf(mainIn(b));
  const def = (main.elm.library.includes.def as Array<Record<string, unknown>>).find((d) => d["localIdentifier"] === "AIFrailLTCF")!;
  return { def, save: () => main.save(main.elm) };
};
const cmsLibraryIn = (name: string) => fresh(libraryIn(cms130.bundle as unknown as B, name));

test("a translation carrying a changed CMS shared library passes, built as the builder builds one", () => {
  assert.deepEqual(problems130(fx130.bundle), []);
  const b = clone130();
  // Non-vacuous: the changed library is there under WorkWell's identity, and CMS's is gone.
  const changed = libraryIn(b, CMS130_CHANGED.name);
  assert.equal(changed["url"], `urn:workwell:library:${CMS130_CHANGED.name}`);
  assert.ok(!b.entry.some((e) => e.resource["name"] === CMS130_CHANGED_FROM.name), "CMS's library is replaced, not kept beside the copy");
  // The main library includes it by the bare name and WorkWell's version, and depends on WorkWell's canonical.
  const { def } = aifInclude(b);
  assert.deepEqual([def["path"], def["version"]], [CMS130_CHANGED.name, "ww-2027.1"]);
  assert.ok((mainIn(b)["relatedArtifact"] as Array<Record<string, unknown>>).some((r) => r["resource"] === `${CMS130_CHANGED.url}|ww-2027.1`));
  // The changed library's depends-on still names CMS's unchanged libraries by CMS's canonical — exempt, as
  // the main library's are — and its ELM includes them namespaced.
  assert.ok((changed["relatedArtifact"] as Array<Record<string, unknown>>).some((r) => r["type"] === "depends-on" && String(r["resource"]).startsWith("https://madie.cms.gov/Library/")));
  assert.ok((elmOf(changed).elm.library.includes.def as Array<{ path: string }>).some((d) => d.path.startsWith("https://madie.cms.gov/")));
  // The manifest's record of it: listed as changed, not as unchanged, traced to CMS's committed ELM.
  assert.ok(!fx130.manifest.derived!.unchangedLibraries.some((l) => l.name === CMS130_CHANGED.name));
  assert.deepEqual([changedEntry.from.name, changedEntry.from.version], [CMS130_CHANGED_FROM.name, CMS130_CHANGED_FROM.version]);
  assert.equal(changedEntry.from.elmSha256, libraryElmSha256(cmsLibraryIn(CMS130_CHANGED_FROM.name)));
});

test("a namespaced include in an unchanged library resolves, as fqm resolves it: by the name after the last '/'", () => {
  // Non-vacuous: CMS's committed ELM really does write its includes namespaced, in both translations.
  for (const bundle of [fixture.bundle, fx130.bundle] as unknown as B[]) {
    const hospice = elmOf(libraryIn(bundle, "Hospice")).elm;
    assert.ok((hospice.library.includes.def as Array<{ path: string }>).every((d) => d.path.startsWith("https://madie.cms.gov/")), "Hospice includes namespaced");
  }
  assert.deepEqual(problems(fixture.bundle), []);
  assert.deepEqual(problems130(fx130.bundle), []);
  // And a different namespace resolves the same way: only the segment after the last '/' is matched.
  const b = clone130();
  const hospice = elmOf(libraryIn(b, "Hospice"));
  for (const d of hospice.elm.library.includes.def as Array<{ path: string }>) d.path = `https://example.org/elsewhere/${d.path.slice(d.path.lastIndexOf("/") + 1)}`;
  hospice.save(hospice.elm);
  // The edit breaks Hospice's pin (its bytes moved), and nothing else: every include still resolves.
  assert.deepEqual(problems130(b), [`cms130: library Hospice|6.18.000 is listed as unchanged but its ELM does not match its pin`]);
});

test("an include left at CMS's library resolves to nothing, and WorkWell's copy is then never run", () => {
  const b = clone130();
  const include = aifInclude(b);
  include.def["path"] = `https://madie.cms.gov/${CMS130_CHANGED_FROM.name}`;
  include.def["version"] = CMS130_CHANGED_FROM.version;
  include.save();
  const list = problems130(b);
  expect(
    list,
    new RegExp(`library ${esc(fx130.manifest.measureName)}\\|ww-2027\\.1 includes AIFrailLTCF as 'https://madie\\.cms\\.gov/AdvancedIllnessandFrailty' version 1\\.27\\.000, which resolves to no library in the bundle; the engine matches 'AdvancedIllnessandFrailty' \\(the path after its last '/'\\)`),
  );
  expect(list, new RegExp(`library ${esc(CHANGED_KEY)} is in the bundle, but nothing the main library includes, directly or through another library, resolves to it`));
  // CumulativeMedicationDuration is included only through the changed library, so it is stranded too.
  expect(list, /library CumulativeMedicationDuration\|6\.0\.000 is in the bundle, but nothing the main library includes/);

  // The right name at CMS's version resolves to nothing either: the version is matched as well.
  const versioned = clone130();
  const atCmsVersion = aifInclude(versioned);
  atCmsVersion.def["version"] = CMS130_CHANGED_FROM.version;
  atCmsVersion.save();
  expect(problems130(versioned), new RegExp(`includes AIFrailLTCF as '${esc(CMS130_CHANGED.name)}' version 1\\.27\\.000, which resolves to no library in the bundle`));
});

test("a urn: include path is refused: fqm keeps what follows the last '/', and a urn has none", () => {
  const b = clone130();
  const include = aifInclude(b);
  include.def["path"] = CMS130_CHANGED.url;
  include.save();
  const list = problems130(b);
  expect(list, new RegExp(`includes AIFrailLTCF as '${esc(CMS130_CHANGED.url)}' version ww-2027\\.1, which resolves to no library in the bundle; the engine matches '${esc(CMS130_CHANGED.url)}'`));
  expect(list, new RegExp(`library ${esc(CHANGED_KEY)} is in the bundle, but nothing the main library includes`));
});

test("CMS's library left in the bundle beside WorkWell's copy is refused, listed or not", () => {
  const cmsLibrary = cmsLibraryIn(CMS130_CHANGED_FROM.name);
  const b = clone130();
  b.entry.push({ resource: cmsLibrary });
  // Pinned as carried unchanged, it passes its pin (it IS CMS's) — and is refused as never run, and as the
  // library the changed one replaces.
  const pinned = derived130With({
    unchangedLibraries: [...fx130.manifest.derived!.unchangedLibraries, { name: CMS130_CHANGED_FROM.name, version: CMS130_CHANGED_FROM.version, elmSha256: changedEntry.from.elmSha256 }],
  });
  assert.deepEqual(problems130(b, pinned), [
    `cms130: library ${FROM_KEY} is in the bundle, but nothing the main library includes, directly or through another library, resolves to it; a library the engine never runs is not part of the translation`,
    `cms130: CMS's ${FROM_KEY}, which changed library ${CHANGED_KEY} replaces, is still in the bundle; a translation carries WorkWell's copy instead of CMS's library, never beside it`,
  ]);
  // Unlisted, it is also unaccounted for, and held to WorkWell's identity, which it fails.
  const list = problems130(fresh(b));
  expect(list, new RegExp(`library ${esc(FROM_KEY)} is neither listed as carried unchanged`));
  expect(list, new RegExp(`library ${esc(FROM_KEY)} is in the bundle, but nothing the main library includes`));
  expect(list, new RegExp(`CMS's ${esc(FROM_KEY)}, which changed library ${esc(CHANGED_KEY)} replaces, is still in the bundle`));
  expect(list, new RegExp(`translated changed library ${esc(FROM_KEY)} still carries CMS's identity`));
});

test("an include more than one library answers to is refused: the engine would silently take the first", () => {
  const b = clone130();
  b.entry.push({ resource: fresh(libraryIn(b, "Status")) });
  const list = problems130(b);
  expect(list, /library WorkWellCMS130Translation2027\|ww-2027\.1 includes Status as 'https:\/\/madie\.cms\.gov\/Status' version 1\.15\.000, which 2 libraries in the bundle answer to \(Status\|1\.15\.000, Status\|1\.15\.000\); the engine takes the first in bundle order/);
  expect(list, /library Status\|1\.15\.000 is in the bundle, but nothing the main library includes/);

  // The Measure's own logic is resolved the same way, by the main library's ELM identifier.
  const twin = clone130();
  const copy = fresh(mainIn(twin));
  copy["url"] = "urn:workwell:library:Twin";
  twin.entry.push({ resource: copy });
  expect(
    problems130(twin),
    /the main library WorkWellCMS130Translation2027\|ww-2027\.1's ELM is identified as 'WorkWellCMS130Translation2027\|ww-2027\.1', and so is another library in the bundle \(WorkWellCMS130Translation2027\|ww-2027\.1\); the engine runs the first of them/,
  );
});

test("an include with no path is refused, not passed over", () => {
  const b = clone130();
  const main = elmOf(mainIn(b));
  delete (main.elm.library.includes.def as Array<Record<string, unknown>>).find((d) => d["localIdentifier"] === "SDE")!["path"];
  main.save(main.elm);
  expect(problems130(b), /library WorkWellCMS130Translation2027\|ww-2027\.1 includes SDE with no path, which the engine cannot resolve/);
});

test("every library besides the main one is accounted for exactly once, and no record names a library the bundle lacks", () => {
  // The changedLibraries record dropped: the copy is then accounted for by nothing.
  assert.deepEqual(problems130(fx130.bundle, derived130With({ changedLibraries: undefined })), [
    `cms130: library ${CHANGED_KEY} is neither listed as carried unchanged (unchangedLibraries) nor as changed (changedLibraries); every library besides the main one is accounted for in exactly one`,
  ]);
  assert.deepEqual(problems130(fx130.bundle, derived130With({ changedLibraries: [] })).length, 1);

  // Listed in both.
  const both = derived130With({
    unchangedLibraries: [
      ...fx130.manifest.derived!.unchangedLibraries,
      { name: CMS130_CHANGED.name, version: CMS130_CHANGED.version, elmSha256: libraryElmSha256(libraryIn(clone130(), CMS130_CHANGED.name))! },
    ],
  });
  expect(problems130(fx130.bundle, both), new RegExp(`library ${esc(CHANGED_KEY)} is listed both as carried unchanged and as changed; it is one or the other`));

  // A record of a library that is not there.
  const ghost = derived130With({ unchangedLibraries: [...fx130.manifest.derived!.unchangedLibraries, { name: "Ghost", version: "1.0.000", elmSha256: `sha256:${"0".repeat(64)}` }] });
  assert.deepEqual(problems130(fx130.bundle, ghost), ["cms130: unchangedLibraries lists Ghost|1.0.000, which is not in the bundle"]);

  // The main library is named by the translation's identity, never listed.
  const mainKey = `${fx130.manifest.measureName}|ww-2027.1`;
  const mainListed = derived130With({ changedLibraries: [changedEntry, { ...changedEntry, name: fx130.manifest.measureName }] });
  expect(problems130(fx130.bundle, mainListed), new RegExp(`the main library ${esc(mainKey)} is listed in changedLibraries; it carries the translation's own identity and is listed in neither`));

  // Listed twice.
  expect(problems130(fx130.bundle, derived130With({ changedLibraries: [changedEntry, changedEntry] })), new RegExp(`changedLibraries lists ${esc(CHANGED_KEY)} more than once`));
});

test("each changedLibraries entry names one library and traces it to CMS's committed library, which is gone", () => {
  // A wrong hash for CMS's ELM: the record must name the exact library the edit was made to.
  const wrong = `sha256:${"7".repeat(64)}`;
  assert.deepEqual(problems130(fx130.bundle, withChanged((e) => ({ ...e, from: { ...e.from, elmSha256: wrong } }))), [
    `cms130: changed library ${CHANGED_KEY} says it was edited from CMS's ${FROM_KEY} with ELM ${wrong}, but CMS's committed ELM for it is ${changedEntry.from.elmSha256}`,
  ]);
  // A CMS library CMS's artifact does not hold.
  expect(
    problems130(fx130.bundle, withChanged((e) => ({ ...e, from: { ...e.from, version: "1.26.000" } }))),
    new RegExp(`changed library ${esc(CHANGED_KEY)} says it was edited from CMS's AdvancedIllnessandFrailty\\|1\\.26\\.000, which CMS's committed artifact does not hold`),
  );
  // No provenance at all.
  expect(problems130(fx130.bundle, withChanged(({ from: _from, ...e }) => e)), new RegExp(`changed library ${esc(CHANGED_KEY)} does not name the CMS library it was edited from`));
  // A malformed edit hash.
  expect(problems130(fx130.bundle, withChanged((e) => ({ ...e, translationSha256: "sha256:edit" }))), new RegExp(`changed library ${esc(CHANGED_KEY)}'s translationSha256 'sha256:edit' is not a sha256:<64 hex> digest`));
  // An entry naming a library the bundle does not hold: and the real one is then unaccounted for.
  const elsewhere = problems130(fx130.bundle, withChanged((e) => ({ ...e, name: "WorkWellNothing2027" })));
  expect(elsewhere, /changedLibraries lists WorkWellNothing2027\|ww-2027\.1, which is not in the bundle; each entry names exactly one/);
  expect(elsewhere, new RegExp(`library ${esc(CHANGED_KEY)} is neither listed`));
  // Two libraries answering to one entry.
  const twice = clone130();
  twice.entry.push({ resource: fresh(libraryIn(twice, CMS130_CHANGED.name)) });
  expect(problems130(twice), new RegExp(`changedLibraries lists ${esc(CHANGED_KEY)}, which matches 2 libraries in the bundle; each entry names exactly one`));
});

test("a hand-edited changedLibraries comes back as sentences, never as an exception in the router", () => {
  let list: readonly string[] = [];
  assert.doesNotThrow(() => (list = problems130(fx130.bundle, derived130With({ changedLibraries: {} as never }))));
  expect(list, /derived\.changedLibraries is not a list/);
  assert.doesNotThrow(() => (list = problems130(fx130.bundle, derived130With({ changedLibraries: [null, 5, {}, { from: null }] as never, unchangedLibraries: "x" as never }))));
  expect(list, /derived\.unchangedLibraries is not a list/);
  expect(list, /changedLibraries lists undefined\|undefined, which is not in the bundle/);
  expect(list, /changed library undefined\|undefined does not name the CMS library it was edited from/);
});

test("a changed library is scanned whole for CMS's identity; only a depends-on naming an unchanged library is exempt", () => {
  // CMS's resource identifier put back: its system is CMS's host.
  let b = clone130();
  libraryIn(b, CMS130_CHANGED.name)["identifier"] = cmsLibraryIn(CMS130_CHANGED_FROM.name)["identifier"];
  expect(problems130(b), new RegExp(`translated changed library ${esc(CHANGED_KEY)} still carries CMS's identity in 1 place\\(s\\): Library\\.identifier\\[0\\]\\.system 'https://madie\\.cms\\.gov/login'`));
  // CMS's host, and CMS's measure short name, where no field check looks.
  b = clone130();
  libraryIn(b, CMS130_CHANGED.name)["purpose"] = "see https://madie.cms.gov";
  expect(problems130(b), new RegExp(`translated changed library ${esc(CHANGED_KEY)} still carries CMS's identity in 1 place\\(s\\): Library\\.purpose`));
  b = clone130();
  libraryIn(b, CMS130_CHANGED.name)["purpose"] = "the CMS130FHIR exclusions";
  expect(problems130(b), new RegExp(`translated changed library ${esc(CHANGED_KEY)} still carries CMS's identity in 1 place\\(s\\): Library\\.purpose`));
  // A depends-on naming CMS's library the copy replaces is not exempt: that library is not carried unchanged.
  b = clone130();
  const changed = libraryIn(b, CMS130_CHANGED.name);
  changed["relatedArtifact"] = [...(changed["relatedArtifact"] as unknown[]), { type: "depends-on", resource: `https://madie.cms.gov/Library/${CMS130_CHANGED_FROM.name}|${CMS130_CHANGED_FROM.version}` }];
  expect(problems130(b), new RegExp(`translated changed library ${esc(CHANGED_KEY)} still carries CMS's identity in 1 place\\(s\\): Library\\.relatedArtifact\\[\\d+\\]\\.resource`));
});

test("the main library's depends-on still naming CMS's edited library is refused", () => {
  const b = clone130();
  const cmsCanonical = `https://madie.cms.gov/Library/${CMS130_CHANGED_FROM.name}|${CMS130_CHANGED_FROM.version}`;
  const main = mainIn(b);
  main["relatedArtifact"] = (main["relatedArtifact"] as Array<Record<string, unknown>>).map((r) => (r["resource"] === `${CMS130_CHANGED.url}|ww-2027.1` ? { ...r, resource: cmsCanonical } : r));
  assert.ok((main["relatedArtifact"] as Array<Record<string, unknown>>).some((r) => r["resource"] === cmsCanonical), "non-vacuous: the entry was reverted");
  expect(problems130(b), /translated main library still carries CMS's identity in 1 place\(s\): Library\.relatedArtifact\[\d+\]\.resource 'https:\/\/madie\.cms\.gov\/Library\/AdvancedIllnessandFrailty\|1\.27\.000'/);
});

test("the Measure's copyright is CMS's, verbatim: neither edited, dropped nor added", () => {
  const sentence = /the translated Measure's copyright is not CMS's Measure's, verbatim/;
  assert.equal(measureIn(clone130())["copyright"], measureIn(cms130.bundle as unknown as B)["copyright"], "non-vacuous: CMS's Measure carries one");
  let b = clone130();
  measureIn(b)["copyright"] = `${String(measureIn(b)["copyright"])} `;
  assert.deepEqual(problems130(b).filter((p) => sentence.test(p)).length, 1);
  b = clone130();
  delete measureIn(b)["copyright"];
  expect(problems130(b), sentence);
  b = clone();
  delete measureIn(b)["copyright"];
  expect(problems(b), sentence);
  // Absent on both is equal.
  const noCopyright = fresh(cms137.bundle as unknown as B);
  delete measureIn(noCopyright)["copyright"];
  b = clone();
  delete measureIn(b)["copyright"];
  assert.deepEqual(problems(b, fixture.manifest, { ...cms137, bundle: noCopyright as never }), []);
});

test("the rewrite is idempotent over the fixture's own identity", () => {
  const twice = rewriteDerivedIdentity(fixture.bundle as never, {
    url: FIXTURE_URL,
    version: "ww-2027.1",
    name: "WorkWellCMS137Translation2027",
    title: "WorkWell translation of CMS137v15",
    derivedFrom: "CMS137v15",
    effectivePeriod: { start: "2027-01-01", end: "2027-12-31" },
  });
  assert.deepEqual(twice, fixture.bundle);
});

// ---- D10 (#782): a library's computed data requirements describe its own ELM ----------------------------

const MAIN_137 = `${String(mainIn(fixture.bundle as unknown as B)["name"])}|ww-2027.1`;
const STALE = "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.198.12.1071";
type Related = Array<Record<string, unknown>>;
type DataRequirements = Array<{ codeFilter?: Array<{ valueSet?: string }> }>;
const relatedOf = (library: Res) => library["relatedArtifact"] as Related;
const dataRequirementsOf = (library: Res) => library["dataRequirement"] as DataRequirements;
const d10 = (list: readonly string[]) => list.filter((p) => / names? value set | declares value set | cqf-directReferenceCode /.test(p));
const firstDeclared = () => (elmOf(mainIn(clone())).elm.library.valueSets.def as Array<{ id: string }>)[0]!.id;

test("D10: a library whose lists still name a value set its ELM no longer declares is refused (the stale-1071 case)", () => {
  const b = clone();
  const main = mainIn(b);
  const { elm, save } = elmOf(main);
  const dropped = (elm.library.valueSets.def as Array<{ id: string }>).shift()!.id;
  save(elm);
  // Non-vacuous: CMS's lists name it in both places, as MADiE wrote them.
  assert.ok(relatedOf(main).some((r) => r["resource"] === dropped));
  assert.ok(dataRequirementsOf(main).some((d) => (d.codeFilter ?? []).some((c) => c.valueSet === dropped)));
  const list = problems(b);
  expect(list, new RegExp(`library ${esc(MAIN_137)}'s relatedArtifact depends-on names value set ${esc(dropped)}, which its ELM does not declare`));
  expect(list, new RegExp(`library ${esc(MAIN_137)}'s dataRequirement code filters name value set ${esc(dropped)}, which its ELM does not declare`));
  // One sentence per list, not one per dataRequirement entry naming it.
  assert.equal(d10(list).length, 2, JSON.stringify(d10(list)));
});

test("D10: a value set only a dataRequirement code filter names is refused on its own", () => {
  const b = clone();
  dataRequirementsOf(mainIn(b)).push({ codeFilter: [{ valueSet: STALE }] });
  expect(problems(b), new RegExp(`dataRequirement code filters name value set ${esc(STALE)}`));
});

test("D10: a value set the ELM declares and neither list names is refused; the rule is the union of the two lists", () => {
  const declared = firstDeclared();
  // Named only by a code filter (MADiE also names it in relatedArtifact): the union still covers it.
  let b = clone();
  mainIn(b)["relatedArtifact"] = relatedOf(mainIn(b)).filter((r) => r["resource"] !== declared);
  assert.deepEqual(d10(problems(b)), []);
  // Named by neither.
  b = clone();
  const main = mainIn(b);
  main["relatedArtifact"] = relatedOf(main).filter((r) => r["resource"] !== declared);
  for (const d of dataRequirementsOf(main)) d.codeFilter = (d.codeFilter ?? []).filter((c) => c.valueSet !== declared);
  const list = problems(b);
  expect(list, new RegExp(`library ${esc(MAIN_137)}'s ELM declares value set ${esc(declared)}, which neither its relatedArtifact nor its dataRequirement names`));
  assert.equal(d10(list).length, 1);
});

test("D10: relatedArtifact is read exactly as fqm reads it: depends-on only, the legacy url first, then resource", () => {
  const declared = firstDeclared();
  const withEntry = (entry: Record<string, unknown>) => {
    const b = clone();
    relatedOf(mainIn(b)).push(entry);
    return d10(problems(b));
  };
  expect(withEntry({ type: "depends-on", url: STALE }), new RegExp(`relatedArtifact depends-on names value set ${esc(STALE)}`));
  expect(withEntry({ type: "depends-on", url: "http://example.org/Library/Other", resource: STALE }), new RegExp(esc(STALE)));
  // fqm takes `url` when it names a value set, and then never reads `resource`.
  assert.deepEqual(withEntry({ type: "depends-on", url: declared, resource: STALE }), []);
  // Nor does it read any other relation type, or a URL without "ValueSet" in it.
  assert.deepEqual(withEntry({ type: "composed-of", resource: STALE }), []);
  assert.deepEqual(withEntry({ type: "depends-on", resource: "http://example.org/valueset/lowercase" }), []);
});

test("D10 holds every library, not only the ones WorkWell compiled: a carried-unchanged library's lists are checked too", () => {
  const b = clone();
  relatedOf(libraryIn(b, "SupplementalDataElements")).push({ type: "depends-on", resource: STALE });
  expect(problems(b), new RegExp(`library SupplementalDataElements\\|5\\.1\\.000's relatedArtifact depends-on names value set ${esc(STALE)}`));
});

test("D10: a cqf-directReferenceCode its ELM's codes.def does not declare is refused, matched by code AND system", () => {
  const ext = (system: string, code: string) => ({ url: "http://hl7.org/fhir/StructureDefinition/cqf-directReferenceCode", valueCoding: { system, code } });
  // The v14 qualifier code CMS125's main library would still claim after the v15 edit.
  let b = clone();
  mainIn(b)["extension"] = [ext("http://snomed.info/sct", "7771000")];
  expect(problems(b), new RegExp(`library ${esc(MAIN_137)}'s cqf-directReferenceCode extension names code 7771000 of http://snomed.info/sct, which its ELM does not declare`));
  // Hospice declares this SNOMED code; the same code under another system is not it.
  const hospiceCode = "428371000124100";
  b = clone();
  const hospice = libraryIn(b, "Hospice");
  assert.ok((hospice["extension"] as Array<{ valueCoding?: { code?: string } }>).some((e) => e.valueCoding?.code === hospiceCode), "non-vacuous: Hospice already names it");
  (hospice["extension"] as unknown[]).push(ext("http://loinc.org", hospiceCode));
  expect(problems(b), new RegExp(`library Hospice\\|6\\.18\\.000's cqf-directReferenceCode extension names code ${hospiceCode} of http://loinc\\.org`));
  b = clone();
  (libraryIn(b, "Hospice")["extension"] as unknown[]).push(ext("http://snomed.info/sct", hospiceCode));
  assert.deepEqual(d10(problems(b)), []);
  // A malformed extension is a sentence, not an exception.
  b = clone();
  mainIn(b)["extension"] = [{ url: "http://hl7.org/fhir/StructureDefinition/cqf-directReferenceCode" }];
  expect(problems(b), /cqf-directReferenceCode extension names code undefined of undefined/);
});

test("D10: recomputedDataRequirements names only libraries WorkWell compiled, read defensively", () => {
  const recomputed = (value: unknown) => derivedWith({ recomputedDataRequirements: value as string[] });
  const mainName = String(mainIn(clone())["name"]);
  assert.deepEqual(problems(fixture.bundle, recomputed([mainName])), []);
  expect(problems(fixture.bundle, recomputed(["NoSuchLibrary"])), /recomputedDataRequirements names 'NoSuchLibrary', which is not a library WorkWell compiled/);
  // A library carried unchanged keeps CMS's lists; a record of recomputing them is false.
  expect(problems(fixture.bundle, recomputed(["Hospice"])), /recomputedDataRequirements names 'Hospice'/);
  expect(problems(fixture.bundle, recomputed(mainName)), /recomputedDataRequirements is not a list/);
  expect(problems(fixture.bundle, recomputed([7])), /recomputedDataRequirements\[0\] is not a library name/);
  expect(problems(fixture.bundle, recomputed([mainName, mainName])), new RegExp(`lists '${mainName}' more than once`));
  // A changed library is one WorkWell compiled; the CMS library it replaced is not in the bundle at all.
  const main130 = String(mainIn(clone130())["name"]);
  assert.deepEqual(problems130(fx130.bundle, derived130With({ recomputedDataRequirements: [main130, CMS130_CHANGED.name] })), []);
  expect(problems130(fx130.bundle, derived130With({ recomputedDataRequirements: [CMS130_CHANGED_FROM.name] })), new RegExp(`names '${CMS130_CHANGED_FROM.name}'`));
});

test("D10: the committed CMS137 and CMS130 translations pass, and the per-library rule finds their lists exact", () => {
  for (const id of ["cms137", "cms130"]) {
    const translation = loadDerivedArtifact(id);
    assert.ok(translation, `${id}'s translation is committed`);
    assert.deepEqual(derivedIdentityProblems(translation.bundle as never, translation.manifest, loadOfficialArtifact(id)), [], id);
    assert.deepEqual(bundleDataRequirementProblems(translation.bundle), [], id);
  }
});

test("D10's per-library rule: a library with no ELM library object is one sentence, and malformed lists read as empty", () => {
  assert.deepEqual(libraryDataRequirementProblems({ name: "X", version: "1" }, {}), ["library X|1 carries no ELM library to check its data requirements against"]);
  assert.deepEqual(libraryDataRequirementProblems({ name: "X", version: "1", relatedArtifact: "not a list", dataRequirement: [null] }, { library: {} }), []);
});
