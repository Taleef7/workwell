/**
 * The static guard over `measures/derived/`: every committed translation must load as a translation, pin
 * its own bundle bytes, and pass every router construction check the committed files can decide — in the
 * default suite, so an unfit translation fails CI before any stack could be configured to route it. Across
 * translations, a library canonical and version means one ELM (`divergentLibraries`).
 *
 * cms137 (ww-2027.1) is the first committed translation. The directory also holds the QI-Core model info
 * and the NOTICE; the guard must still SEE the model-info directory and skip it, or a translation named
 * oddly could hide the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { libraryElmSha256 } from "../standards/derived-identity.ts";
import { CMS130_CHANGED, derivedCms130Changed, derivedCms137 } from "../test-support/derived-fixture.ts";
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

test("the guard sees the model-info directory, skips it, and finds exactly the committed translations", () => {
  assert.ok(dirs.includes("_modelinfo"), "the guard must be looking at the right directory");
  assert.ok(!VALID_CATALOG_ID.test("_modelinfo"), "and the model info can never be mistaken for a translation");
  // Every translation this repo ships, by name: a new one is added here deliberately, and one that went
  // missing or was renamed fails here rather than silently leaving the loop below with nothing to check.
  assert.deepEqual(artifacts, ["cms130", "cms137"], "the committed translations");
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

type LibraryEntry = { resource?: { resourceType?: string; url?: unknown; version?: unknown } & Record<string, unknown> };

/**
 * Every library canonical|version that more than one bundle carries with DIFFERENT ELM bytes, as sentences.
 * A canonical and version name one library: the router resolves includes by name and version, a cache or a
 * reader keys on the canonical, and nothing tells two compiles apart once they share both. So when CMS125's
 * translation carries the changed AdvancedIllnessandFrailty that CMS130's already carries, it must carry
 * CMS130's bytes, or take a new revision. CMS's own shared libraries agree across every official artifact
 * today, so they are held to the same rule rather than exempted.
 */
function divergentLibraries(bundles: Array<[id: string, bundle: unknown]>): string[] {
  const byCanonical = new Map<string, Map<string, string[]>>();
  for (const [id, bundle] of bundles) {
    for (const entry of ((bundle as { entry?: LibraryEntry[] }).entry ?? [])) {
      const library = entry.resource;
      if (library?.resourceType !== "Library") continue;
      const canonical = `${String(library.url)}|${String(library.version)}`;
      const elm = libraryElmSha256(library) ?? "no ELM";
      const byElm = byCanonical.get(canonical) ?? new Map<string, string[]>();
      byElm.set(elm, [...(byElm.get(elm) ?? []), id]);
      byCanonical.set(canonical, byElm);
    }
  }
  return [...byCanonical]
    .filter(([, byElm]) => byElm.size > 1)
    .map(([canonical, byElm]) => `${canonical} carries ${byElm.size} different ELMs: ${[...byElm].map(([elm, ids]) => `${ids.join(", ")} (${elm})`).join("; ")}`);
}

test("the cross-translation check has teeth: one canonical and version with two ELMs is caught", () => {
  const fit137 = derivedCms137();
  const fit130 = derivedCms130Changed();
  // Non-vacuous: the two translations share CMS's libraries under one canonical, and they agree.
  const canonicals = (bundle: unknown) =>
    new Set(((bundle as { entry?: LibraryEntry[] }).entry ?? []).map((e) => `${String(e.resource?.url)}|${String(e.resource?.version)}`));
  const in130 = canonicals(fit130.bundle);
  assert.ok([...canonicals(fit137.bundle)].filter((c) => in130.has(c)).length >= 4, "the fixtures share CMS's libraries");
  assert.deepEqual(divergentLibraries([["cms137", fit137.bundle], ["cms130", fit130.bundle]]), []);

  // A second translation carrying the changed library under the same canonical and version, compiled
  // differently: refused, naming both.
  const other = JSON.parse(JSON.stringify(fit130.bundle)) as { entry: Array<{ resource: Record<string, unknown> }> };
  const changed = other.entry.find((e) => e.resource["url"] === CMS130_CHANGED.url)!.resource;
  const content = (changed["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8"));
  elm.library.statements.def.pop();
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
  const found = divergentLibraries([["cms130", fit130.bundle], ["cms125", other]]);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0]!, new RegExp(`^${CMS130_CHANGED.url}\\|ww-2027\\.1 carries 2 different ELMs: cms130 \\(sha256:[0-9a-f]{64}\\); cms125 \\(sha256:[0-9a-f]{64}\\)$`));
});

test("across every committed translation, a library canonical and version carries byte-identical ELM", () => {
  const bundles = artifacts.map((id): [string, unknown] => [id, loadDerivedArtifact(id)?.bundle]);
  assert.ok(bundles.every(([, bundle]) => bundle !== undefined), "every committed translation loads");
  assert.deepEqual(divergentLibraries(bundles), []);
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
    // What the identity check cannot ask of the fixture (built on CMS's own ELM with its identifier
    // renamed) it can ask of a COMMITTED translation: the main library's ELM is WorkWell's compile. Our
    // compile names its includes bare, so CMS's host appearing anywhere in it means CMS's ELM was carried
    // instead; and the keys that would carry CMS's CQL text are what the builder strips.
    const resources = ((translation.bundle as { entry?: Array<{ resource: Record<string, unknown> }> }).entry ?? []).map((e) => e.resource);
    const measure = resources.find((r) => r.resourceType === "Measure") as { library?: string[] } | undefined;
    const mainUrl = measure?.library?.[0];
    assert.ok(mainUrl?.startsWith("urn:workwell:library:"), `${id}: the Measure must name WorkWell's main library, got ${String(mainUrl)}`);
    const main = resources.find((r) => r.resourceType === "Library" && r.url === mainUrl) as { content?: Array<{ data?: string }> } | undefined;
    const elm = Buffer.from(main?.content?.[0]?.data ?? "", "base64").toString("utf8");
    assert.ok(elm.length > 0, `${id}: the main library must carry ELM`);
    assert.doesNotMatch(elm, /madie\.cms\.gov/i, `${id}: the main library's ELM must be WorkWell's compile, which names no CMS host`);
    assert.doesNotMatch(elm, /"(annotation|locator)"\s*:/, `${id}: the main library's ELM must be stripped of the keys that carry CQL text`);
  });
}
