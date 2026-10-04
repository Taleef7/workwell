/**
 * A translation carries WorkWell's identity and no CMS one (LOCKED §4.3). The validator is what the
 * router runs before routing one, so every way of getting the identity wrong must produce a sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { derivedCms137, FIXTURE_URL } from "../test-support/derived-fixture.ts";
import { loadOfficialArtifact } from "../wiring/official-artifacts.ts";
import { createHash } from "node:crypto";
import { derivedIdentityProblems } from "./derived-identity.ts";

interface Res {
  resourceType?: string;
  [key: string]: unknown;
}
const fixture = derivedCms137();
const clone = () => JSON.parse(JSON.stringify(fixture.bundle)) as { entry: Array<{ resource: Res }> };
const measureIn = (b: { entry: Array<{ resource: Res }> }) => b.entry.find((e) => e.resource.resourceType === "Measure")!.resource;
const mainIn = (b: { entry: Array<{ resource: Res }> }) => {
  const url = (measureIn(b)["library"] as string[])[0];
  return b.entry.find((e) => e.resource["url"] === url)!.resource;
};
const cms137 = loadOfficialArtifact("cms137")!;
const problems = (bundle: unknown, manifest = fixture.manifest, base: typeof cms137 | null = cms137) => derivedIdentityProblems(bundle as never, manifest, base);
const expect = (list: string[], pattern: RegExp) => assert.ok(list.some((p) => pattern.test(p)), `expected ${pattern} in ${JSON.stringify(list)}`);

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
  const renamed = problems(b, notUnchanged);
  const sentence = `changed library WorkWellHospice2027|ww-2027.1's ELM is identified as 'Hospice|${cmsVersion}'`;
  assert.ok(renamed.some((p) => p.includes(sentence)), `expected "${sentence}" in ${JSON.stringify(renamed)}`);
  assert.ok(!renamed.some((p) => /keeps CMS's library name|not a ww- version/.test(p)), JSON.stringify(renamed));

  // Identified as itself all the way down: nothing left to refuse about that library.
  const content = (hospice["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8"));
  elm.library.identifier = { id: "WorkWellHospice2027", version: "ww-2027.1" };
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
  assert.deepEqual(problems(b, notUnchanged).filter((p) => p.includes("WorkWellHospice2027")), []);

  // A changed library with no ELM cannot be checked, so it is refused.
  hospice["content"] = [];
  expect(problems(b, notUnchanged), /WorkWellHospice2027\|ww-2027\.1 has no ELM identifier to check/);
});

test("CMS's host is refused in any letter case: the check is a refusal, not a URL parser", () => {
  const b = clone();
  measureIn(b)["publisher"] = "MADiE.CMS.gov";
  expect(problems(b), /publisher still names madie\.cms\.gov/);
});
