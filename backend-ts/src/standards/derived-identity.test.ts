/**
 * A translation carries WorkWell's identity and no CMS one (LOCKED §4.3). The validator is what the
 * router runs before routing one, so every way of getting the identity wrong must produce a sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { derivedCms137, FIXTURE_URL } from "../test-support/derived-fixture.ts";
import { loadOfficialArtifact } from "../wiring/official-artifacts.ts";
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
const problems = (bundle: unknown, manifest = fixture.manifest) => derivedIdentityProblems(bundle as never, manifest);
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

test("an 'unchanged' CMS library whose ELM was in fact changed is caught by its pin", () => {
  const b = clone();
  const library = b.entry.find((e) => e.resource.resourceType === "Library" && e.resource["name"] === "Hospice")!.resource;
  const content = (library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8"));
  elm.library.statements.def.pop();
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
  expect(problems(b), /Hospice\|.+ is listed as unchanged but its ELM does not match its pin/);
});
