/**
 * A translation carries WorkWell's identity and no CMS one (LOCKED §4.3). The validator is what the
 * router runs before routing one, so every way of getting the identity wrong must produce a sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { derivedCms137, FIXTURE_URL } from "../test-support/derived-fixture.ts";
import { loadOfficialArtifact, type OfficialManifest } from "../wiring/official-artifacts.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  derivedIdentityProblems,
  installedTranslatorVersion,
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

  // Identified as itself all the way down: nothing left to refuse about that library.
  const content = (hospice["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8"));
  elm.library.identifier = { id: "WorkWellHospice2027", version: "ww-2027.1" };
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
  assert.deepEqual(problems(fresh(b), notUnchanged).filter((p) => p.includes("WorkWellHospice2027")), []);

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
