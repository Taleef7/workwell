/**
 * `build:derived` refuses before it writes, writes only what passed, and `--verify` catches a committed
 * translation that its inputs no longer rebuild byte for byte.
 *
 * Most tests drive the CLI with stubs below the boundary it owns: an "upstream" bundle made from the
 * COMMITTED official cms137 artifact with CQL-shaped stand-ins written for the test (never CMS's CQL), a
 * compile that returns CMS's committed ELM with the extra keys a real compile carries, and a terminology
 * emit that writes a small sidecar. The shared-library edits (#779) run the same way on the committed
 * official cms130 artifact, whose AdvancedIllnessandFrailty only the main library includes. Everything is
 * written under a temporary directory. The last test is the real thing — CMS's CQL from
 * `.official-content`, our translator — and skips itself when that licensed, local-only checkout is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spanSha256, type CqlEdit } from "../../standards/derived-build.ts";
import { derivedIdentityProblems, libraryElmSha256 } from "../../standards/derived-identity.ts";
import { CMS_TRANSLATOR_OPTIONS, type CompiledLibrary, type LibrarySource } from "../../standards/qicore-compile.ts";
import { loadOfficialArtifact, type OfficialArtifact, type OfficialManifest } from "../../wiring/official-artifacts.ts";
import { main, parseArgs, type BuildDerivedDeps, type TerminologyEmitRequest } from "./build-derived.ts";

interface Res {
  resourceType?: string;
  [key: string]: unknown;
}
type B = { entry: Array<{ resource: Res }> };
const sha = (data: string | Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const decode = (data: string) => JSON.parse(Buffer.from(data, "base64").toString("utf8"));
const cms137 = loadOfficialArtifact("cms137")!;
const baseBundle = cms137.bundle as unknown as B;
const librariesOf = (b: B) => b.entry.filter((e) => e.resource.resourceType === "Library").map((e) => e.resource);
const measureOf = (b: B) => b.entry.find((e) => e.resource.resourceType === "Measure")!.resource;
const mainOf = (b: B) => librariesOf(b).find((l) => l["url"] === (measureOf(b)["library"] as string[])[0] || l["name"] === (measureOf(b)["library"] as string[])[0])!;
const elmDataOf = (library: Res) => (library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!.data;
const MAIN = "CMS137FHIRSUDTxInitEngagement";
const RELEASE = "http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14";

/** The measure a harness builds: cms137 (no shared-library edit) unless a test says otherwise. */
interface Fixture {
  catalogId: string;
  derivedFrom: string;
  artifact: OfficialArtifact;
}
const CMS137: Fixture = { catalogId: "cms137", derivedFrom: "CMS137v15", artifact: cms137 };
const cms130 = loadOfficialArtifact("cms130")!;
const CMS130: Fixture = { catalogId: "cms130", derivedFrom: "CMS130v15", artifact: cms130 };
const AIF = "AdvancedIllnessandFrailty";
const AIF_VERSION = "1.27.000";
const AIF_WW = "WorkWellAdvancedIllnessandFrailtyTranslation2027";
/** The define the CMS130v15 edit is in; the stub compile changes its comparison as `overlaps` would. */
const AIF_EDITED_DEFINE = "Has Advanced Illness in Year Before or During Measurement Period";

/** CQL-shaped text written for this test; the CLI never sees CMS's CQL outside the smoke test. */
const STAND_IN_MARK = "a stand-in written for build-derived.test.ts";
const standIn = (name: string, version: string) => `library ${name} version '${version}'\n\n// ${STAND_IN_MARK}\ndefine "One": 1\ndefine "Two": 2\n`;
/** An edit of line 4 (`define "One": 1`) of a library's stand-in. */
const editOf = (library: string, version: string, replacement = "define \"One\": 10"): CqlEdit => ({
  library,
  anchorSha256: spanSha256(standIn(library, version), 4, 4),
  startLine: 4,
  endLine: 4,
  replacement,
});

/** The committed official bundle with each Library carrying stand-in CQL beside its ELM, as upstream ships both. */
function upstreamBundle(base: B = baseBundle): B {
  const copy = JSON.parse(JSON.stringify(base)) as B;
  for (const library of librariesOf(copy)) {
    library["content"] = [{ contentType: "text/cql", data: b64(standIn(String(library["name"]), String(library["version"]))) }, ...(library["content"] as unknown[])];
  }
  return copy;
}

/**
 * CMS's committed ELM for each library, carrying what a fresh compile carries (CqlToElmInfo, localIds).
 * A library whose CQL is not its stand-in was edited: its ELM is changed as the CMS130v15 edit changes it —
 * `starts during day of` becomes `overlaps day`, which moves no retrieve — or, given `retrieveEdit`, as
 * an edit that also changes what is fetched.
 */
function stubCompile(base: B = baseBundle, edited: (elm: Elm) => void = overlapsEdit): { compile: BuildDerivedDeps["compile"]; calls: LibrarySource[][] } {
  const calls: LibrarySource[][] = [];
  const compile = (sources: readonly LibrarySource[]): CompiledLibrary[] => {
    calls.push([...sources]);
    return sources.map((source) => {
      const library = librariesOf(base).find((l) => l["name"] === source.name)!;
      const elm = decode(elmDataOf(library));
      elm.library.annotation = [{ type: "CqlToElmInfo", translatorOptions: CMS_TRANSLATOR_OPTIONS.options.join(","), signatureLevel: "All" }];
      elm.library.statements.def[0].localId = "1";
      if (source.cql !== standIn(source.name, source.version)) edited(elm);
      return { name: source.name, version: source.version, elm, warnings: [] };
    });
  };
  return { compile, calls };
}

type Elm = { library: { statements: { def: Array<Record<string, unknown>> } } & Record<string, unknown> };
/** `Start(x) in day of I` → `x overlaps day of I` in the edited define; any other library gets a marker. */
function overlapsEdit(elm: Elm): void {
  const define = elm.library.statements.def.find((d) => d["name"] === AIF_EDITED_DEFINE);
  if (!define) {
    elm.library["editedByTest"] = true;
    return;
  }
  const query = (define["expression"] as { operand: { where: { type: string; operand: Array<{ type: string; operand?: unknown }> } } }).operand;
  assert.equal(query.where.type, "In", "the committed ELM still has CMS's `starts during day of`");
  assert.equal(query.where.operand[0]!.type, "Start");
  query.where = { ...query.where, type: "Overlaps", operand: [query.where.operand[0]!.operand as { type: string }, query.where.operand[1]!] };
}
/** An edit that retrieves a different value set: the first `Advanced Illness` retrieve reads `Frailty Diagnosis`. */
function retrieveEdit(elm: Elm): void {
  overlapsEdit(elm);
  let done = false;
  const walk = (node: unknown): void => {
    if (done || !node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const codes = n["codes"] as { type?: string; name?: string } | undefined;
    if (n["type"] === "Retrieve" && codes?.type === "ValueSetRef" && codes.name === "Advanced Illness") {
      n["codes"] = { ...codes, name: "Frailty Diagnosis" };
      done = true;
      return;
    }
    for (const value of Object.values(n)) walk(value);
  };
  walk(elm.library.statements);
  assert.ok(done, "the stub found the retrieve to change");
}

interface Harness {
  dir: string;
  out: string;
  logs: string[];
  errors: string[];
  emits: Array<TerminologyEmitRequest & { bundleSeen: string }>;
  calls: LibrarySource[][];
  deps: Partial<BuildDerivedDeps>;
  file: (name: string, content: string) => string;
  fixture: Fixture;
}

const SIDECAR_TEXT = `${JSON.stringify({ catalogId: "cms137", source: { repo: "test" }, valueSets: [] })}\n`;
const sidecarBlock = (text = SIDECAR_TEXT) => ({
  file: "terminology.json",
  valueSets: 28,
  codes: 1000,
  truncated: [],
  completion: { source: "vsac", manifest: RELEASE, valueSets: [] },
  sha256: sha(text),
});

function harness(over: Partial<BuildDerivedDeps> = {}, fixture: Fixture = CMS137): Harness {
  const dir = mkdtempSync(join(tmpdir(), "build-derived-test-"));
  const out = join(dir, "out");
  const logs: string[] = [];
  const errors: string[] = [];
  const emits: Harness["emits"] = [];
  const base = fixture.artifact.bundle as unknown as B;
  const { compile, calls } = stubCompile(base);
  const upstream = upstreamBundle(base);
  const deps: Partial<BuildDerivedDeps> = {
    cwd: dir,
    verifyUpstream: () => {},
    load: () => ({ measureBundle: upstream as never }),
    compile,
    modelInfos: () => [],
    runTerminologyEmit: (request) => {
      // The real script reads the new bundle.json from its output directory; it must already be there.
      emits.push({ ...request, bundleSeen: sha(readFileSync(join(request.outputDir, "bundle.json"))) });
      writeFileSync(join(request.outputDir, "terminology.json"), SIDECAR_TEXT);
      return `${JSON.stringify(sidecarBlock(), null, 2)}\n`;
    },
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    ...over,
  };
  const file = (name: string, content: string) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };
  return { dir, out, logs, errors, emits, calls, deps, file, fixture };
}

const argsFor = (h: Harness, extra: string[] = [], edits: CqlEdit[] | null = []) => [
  "--catalog-id", h.fixture.catalogId,
  "--year", "2027",
  "--derived-from", h.fixture.derivedFrom,
  ...(edits ? ["--edits", h.file("edits.json", JSON.stringify(edits))] : []),
  "--package", h.file("package.zip", "a package stand-in"),
  "--vsac-manifest", RELEASE,
  "--output-dir", h.out,
  ...extra,
];
const readManifest = (h: Harness) => JSON.parse(readFileSync(join(h.out, "manifest.json"), "utf8")) as OfficialManifest;
const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

// ---- usage ----------------------------------------------------------------------------------------------

test("--edits is required, and so is --package except with --verify", async () => {
  const h = harness({ verifyUpstream: () => assert.fail("a usage error must stop before any work") });
  assert.equal(await main(argsFor(h, [], null), h.deps), 2);
  assert.match(h.errors.join("\n"), /--edits is required \(an explicit \[\] file means no edits\)/);

  const noPackage = argsFor(h).filter((_, i, all) => all[i] !== "--package" && all[i - 1] !== "--package");
  assert.equal(await main(noPackage, h.deps), 2);
  assert.match(h.errors.join("\n"), /--package is required/);
  assert.equal(parseArgs([...noPackage, "--verify"]).package, undefined, "--verify rebuilds without the package");

  const noRelease = argsFor(h).filter((_, i, all) => all[i] !== "--vsac-manifest" && all[i - 1] !== "--vsac-manifest");
  assert.equal(await main(noRelease, h.deps), 2);
  assert.match(h.errors.join("\n"), /--vsac-manifest is required unless --skip-terminology/);
  assert.equal(parseArgs([...noRelease, "--skip-terminology"]).skipTerminology, true);

  for (const bad of [["--catalog-id", "cms999"], ["--year", "27"], ["--revision", "0"], ["--signature-level", "None"], ["--frobnicate"]]) {
    const argv = argsFor(h);
    const at = argv.indexOf(bad[0]!);
    const patched = at >= 0 ? [...argv.slice(0, at), ...bad, ...argv.slice(at + 2)] : [...argv, ...bad];
    assert.equal(await main(patched, h.deps), 2, `${bad.join(" ")} is a usage error`);
  }
});

// ---- a build --------------------------------------------------------------------------------------------

test("a build writes the bundle, the sidecar and the manifest, and the result passes the router's identity check", async () => {
  const h = harness();
  assert.equal(await main(argsFor(h), h.deps), 0, h.errors.join("\n"));
  assert.deepEqual(filesIn(h.out), ["bundle.json", "manifest.json", "terminology.json"]);
  const bundleBytes = readFileSync(join(h.out, "bundle.json"));
  const manifest = readManifest(h);
  assert.equal(manifest.sha256, sha(bundleBytes));
  assert.equal(readFileSync(join(h.out, "bundle.json"), "utf8"), `${JSON.stringify(JSON.parse(bundleBytes.toString("utf8")), null, 0)}\n`);
  assert.deepEqual(manifest.terminology, sidecarBlock());
  assert.equal(readFileSync(join(h.out, "terminology.json"), "utf8"), SIDECAR_TEXT);
  assert.equal(manifest.derived!.derivedFrom.packageSha256, sha("a package stand-in"));
  assert.equal(manifest.derived!.build.translationSha256, sha(standIn(MAIN, "1.0.000")), "no edits: the translated CQL is the upstream main library's");
  // No shared library edited: no changedLibraries key at all, so CMS137's committed manifest is unchanged.
  assert.deepEqual(Object.keys(manifest.derived!), ["label", "derivedFrom", "base", "build", "unchangedLibraries", "oracles"]);
  assert.equal(manifest.derived!.unchangedLibraries.length, 6);
  assert.ok(h.logs.some((l) => l.includes(", 6 libraries carried unchanged, 0 changed, terminology ")), h.logs.join("\n"));
  assert.deepEqual(derivedIdentityProblems(JSON.parse(bundleBytes.toString("utf8")), manifest, cms137), []);

  // The emit ran on THIS bundle, in a scratch directory that is gone afterwards.
  assert.equal(h.emits.length, 1);
  const [emit] = h.emits;
  assert.deepEqual({ ...emit, outputDir: undefined, bundleSeen: undefined }, {
    catalogId: "cms137",
    vsacManifest: RELEASE,
    baseTerminology: "measures/official/cms137/terminology.json",
    outputDir: undefined,
    bundleSeen: undefined,
  });
  assert.equal(emit!.bundleSeen, sha(bundleBytes));
  assert.notEqual(emit!.outputDir, h.out);
  assert.ok(!existsSync(emit!.outputDir), "the scratch directory is removed");

  // Twice, through the stubbed compile, with all seven libraries each time.
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0]!.map((s) => s.name), librariesOf(baseBundle).map((l) => String(l["name"])));
  // Counts and hashes only: nothing of the CQL is printed.
  assert.ok(![...h.logs, ...h.errors].some((line) => line.includes(STAND_IN_MARK) || line.includes("define \"")), [...h.logs, ...h.errors].join("\n"));
});

test("a compile that is not byte-for-byte reproducible is refused, and nothing is written", async () => {
  let calls = 0;
  const { compile } = stubCompile();
  const h = harness({
    compile: (sources, options) => {
      const compiled = compile(sources, options);
      if (++calls === 2) (compiled.find((c) => c.name === MAIN)!.elm.library as Record<string, unknown>)["drift"] = true;
      return compiled;
    },
  });
  assert.equal(await main(argsFor(h), h.deps), 1);
  assert.match(h.errors.join("\n"), /compiled CMS137FHIRSUDTxInitEngagement to different ELM on two runs \(sha256:[0-9a-f]{64} vs sha256:[0-9a-f]{64}\)/);
  assert.deepEqual(filesIn(h.out), []);
  assert.equal(h.emits.length, 0, "the refusal comes before the terminology is expanded");
});

test("edits land on their library's anchored lines; a library upstream lacks, an edit that changes nothing, or other text is refused", async () => {
  const mainCql = standIn(MAIN, "1.0.000");
  const good = editOf(MAIN, "1.0.000");
  let h = harness();
  assert.equal(await main(argsFor(h, [], [good]), h.deps), 0, h.errors.join("\n"));
  const edited = mainCql.replace("define \"One\": 1\n", "define \"One\": 10\n");
  assert.equal(h.calls[0]!.find((s) => s.name === MAIN)!.cql, edited, "the compile receives the edited main library");
  assert.equal(h.calls[0]!.find((s) => s.name === "Hospice")!.cql, standIn("Hospice", "6.18.000"), "and every other library as shipped");
  assert.equal(readManifest(h).derived!.build.translationSha256, sha(edited));
  assert.equal(readManifest(h).derived!.changedLibraries, undefined, "an edit of the main library alone changes no shared library");

  // A library the upstream bundle does not hold: refused by name before anything is compiled.
  h = harness();
  assert.equal(await main(argsFor(h, [], [good, { ...good, library: "CQMCommonn" }]), h.deps), 1);
  assert.match(h.errors.join("\n"), /the edits name CQMCommonn, which the upstream bundle does not hold \(it holds CMS137FHIRSUDTxInitEngagement, /);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(filesIn(h.out), []);

  // An edit that leaves a library's text as CMS wrote it would put WorkWell's name on CMS's untouched work.
  for (const [library, version] of [[MAIN, "1.0.000"], ["Hospice", "6.18.000"]] as const) {
    h = harness();
    assert.equal(await main(argsFor(h, [], [editOf(library, version, "define \"One\": 1")]), h.deps), 1);
    const literal = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    assert.match(h.errors.join("\n"), new RegExp(`the edits to ${literal(library)} ${literal(version)} leave its CQL byte-equal to CMS's`));
    assert.equal(h.calls.length, 0);
  }

  h = harness();
  assert.equal(await main(argsFor(h, [], [{ ...good, startLine: 5, endLine: 5 }]), h.deps), 1);
  assert.match(h.errors.join("\n"), /edit of CMS137FHIRSUDTxInitEngagement lines 5-5 is anchored to/);
  assert.equal(h.calls.length, 0, "nothing is compiled from CQL the edits do not match");

  h = harness();
  const missing = argsFor(h).map((a, i, all) => (all[i - 1] === "--edits" ? join(h.dir, "absent.json") : a));
  assert.equal(await main(missing, h.deps), 1);
  assert.match(h.errors.join("\n"), /cannot read the edits file/);
});

// ---- shared-library edits (#779) ------------------------------------------------------------------------

const CMS130_MAIN = "CMS130FHIRColorectalCancerScrn";
const elmOfLibrary = (library: Res) => decode(elmDataOf(library));

test("a shared-library edit builds a changed library under WorkWell's name, repoints the main include, and is recorded after the unchanged ones", async () => {
  const h = harness({}, CMS130);
  assert.equal(await main(argsFor(h, [], [editOf(AIF, AIF_VERSION)]), h.deps), 0, h.errors.join("\n"));
  const aifCql = standIn(AIF, AIF_VERSION).replace("define \"One\": 1\n", "define \"One\": 10\n");
  // Compiled under CMS's name, twice, with the main library as CMS wrote it.
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0]!.find((s) => s.name === AIF)!.cql, aifCql);
  assert.equal(h.calls[0]!.find((s) => s.name === CMS130_MAIN)!.cql, standIn(CMS130_MAIN, "1.0.000"));

  const bundle = JSON.parse(readFileSync(join(h.out, "bundle.json"), "utf8")) as B;
  const manifest = readManifest(h);
  const cmsAif = librariesOf(cms130.bundle as unknown as B).find((l) => l["name"] === AIF)!;
  assert.deepEqual(Object.keys(manifest.derived!), ["label", "derivedFrom", "base", "build", "unchangedLibraries", "changedLibraries", "oracles"]);
  assert.deepEqual(manifest.derived!.changedLibraries, [
    { name: AIF_WW, version: "ww-2027.1", from: { name: AIF, version: AIF_VERSION, elmSha256: libraryElmSha256(cmsAif) }, translationSha256: sha(aifCql) },
  ]);
  assert.equal(manifest.derived!.build.translationSha256, sha(standIn(CMS130_MAIN, "1.0.000")), "build.translationSha256 stays the main library's CQL, here unedited");
  const unchanged = manifest.derived!.unchangedLibraries.map((l) => l.name);
  assert.equal(unchanged.length, 8);
  assert.ok(!unchanged.includes(AIF), "a changed library is never also pinned as unchanged");

  // The bundle: CMS's AdvancedIllnessandFrailty is gone, WorkWell's copy holds its slot with OUR ELM.
  const names = librariesOf(bundle).map((l) => String(l["name"]));
  assert.ok(!names.includes(AIF));
  assert.equal(names.indexOf(AIF_WW), librariesOf(cms130.bundle as unknown as B).indexOf(cmsAif));
  const ours = librariesOf(bundle).find((l) => l["name"] === AIF_WW)!;
  assert.equal(ours["url"], `urn:workwell:library:${AIF_WW}`);
  assert.equal(ours["version"], "ww-2027.1");
  const oursElm = elmOfLibrary(ours);
  assert.deepEqual(oursElm.library.identifier, { id: AIF_WW, version: "ww-2027.1" });
  const where = oursElm.library.statements.def.find((d: { name?: string }) => d.name === AIF_EDITED_DEFINE).expression.operand.where;
  assert.equal(where.type, "Overlaps", "the changed library carries OUR compile of the edited text");
  assert.ok(!/"(annotation|locator)":/.test(JSON.stringify(oursElm)), "stripped of CQL text and positions");
  assert.equal(oursElm.library.statements.def[0].localId, "1", "with its localIds kept");
  // The main library includes it by its bare WorkWell name, under the same local identifier.
  const mainLibrary = mainOf(bundle);
  const include = elmOfLibrary(mainLibrary).library.includes.def.find((d: { localIdentifier?: string }) => d.localIdentifier === "AIFrailLTCF");
  assert.deepEqual(include, { localIdentifier: "AIFrailLTCF", path: AIF_WW, version: "ww-2027.1" });
  const dependsOn = (mainLibrary["relatedArtifact"] as Array<{ type?: string; resource?: string }>).filter((r) => r.type === "depends-on").map((r) => r.resource);
  assert.ok(dependsOn.includes(`urn:workwell:library:${AIF_WW}|ww-2027.1`));
  assert.ok(!dependsOn.some((r) => r?.includes(`/Library/${AIF}`)), "no depends-on still names CMS's library");

  assert.ok(
    h.logs.some((l) => l.includes(`, 8 libraries carried unchanged, 1 changed (${AIF_WW} ww-2027.1 from ${AIF} ${AIF_VERSION}), terminology `)),
    h.logs.join("\n"),
  );
  assert.ok(h.logs.some((l) => /1 edit\(s\) applied to AdvancedIllnessandFrailty 1\.27\.000; translated CQL sha256:[0-9a-f]{64}$/.test(l)), h.logs.join("\n"));
  assert.ok(h.logs.some((l) => /0 edit\(s\) applied to CMS130FHIRColorectalCancerScrn 1\.0\.000/.test(l)), h.logs.join("\n"));
  assert.ok(![...h.logs, ...h.errors].some((line) => line.includes(STAND_IN_MARK) || line.includes("define \"")), "nothing of the CQL is printed");

  // And it rebuilds byte for byte; without the edit, it does not.
  assert.equal(await main(argsFor(h, ["--verify", "--skip-terminology"], [editOf(AIF, AIF_VERSION)]), h.deps), 0, h.errors.join("\n"));
  assert.equal(await main(argsFor(h, ["--verify", "--skip-terminology"], []), h.deps), 1);
  assert.match(h.errors.join("\n"), /--verify FAILED[\s\S]*bundle\.json: committed/);
});

test("an edited shared library must be reproducible, compiled with CMS's options, and included by the main library alone", async () => {
  const edits = [editOf(AIF, AIF_VERSION)];
  let calls = 0;
  let h = harness(
    {
      compile: (sources, options) => {
        const compiled = stubCompile(cms130.bundle as unknown as B).compile(sources, options);
        if (++calls === 2) (compiled.find((c) => c.name === AIF)!.elm.library as Record<string, unknown>)["drift"] = true;
        return compiled;
      },
    },
    CMS130,
  );
  assert.equal(await main(argsFor(h, [], edits), h.deps), 1);
  assert.match(h.errors.join("\n"), /compiled AdvancedIllnessandFrailty to different ELM on two runs/);
  assert.deepEqual(filesIn(h.out), []);

  h = harness(
    { compile: (sources, opts) => stubCompile(cms130.bundle as unknown as B).compile(sources, opts).map((c) => (c.name === AIF ? { ...c, elm: { library: { ...c.elm.library, annotation: [] } } } : c)) },
    CMS130,
  );
  assert.equal(await main(argsFor(h, [], edits), h.deps), 1);
  assert.match(h.errors.join("\n"), /AdvancedIllnessandFrailty 1\.27\.000: compiled with options \[\] at undefined, not CMS's/);

  // CMS's recorded options are read on every library an edit names, before anything is compiled.
  const otherOptions = upstreamBundle(cms130.bundle as unknown as B);
  const aif = librariesOf(otherOptions).find((l) => l["name"] === AIF)!;
  const options = (aif["contained"] as Array<{ id?: string; parameter: Array<{ name: string; valueString?: string }> }>).find((r) => r.id === "options")!;
  options.parameter.find((p) => p.name === "signatureLevel")!.valueString = "Overloads";
  h = harness({ load: () => ({ measureBundle: otherOptions as never }) }, CMS130);
  assert.equal(await main(argsFor(h, [], edits), h.deps), 1);
  assert.match(h.errors.join("\n"), /Library AdvancedIllnessandFrailty was compiled with options this path does not reproduce: signatureLevel Overloads/);
  assert.equal(h.calls.length, 0);

  // QICoreCommon is included by Hospice, Status and others: rewiring them would break their pins.
  h = harness({}, CMS130);
  assert.equal(await main(argsFor(h, [], [editOf("QICoreCommon", "4.0.000")]), h.deps), 1);
  assert.match(h.errors.join("\n"), /REFUSED — QICoreCommon 4\.0\.000 is also included by .*Hospice 6\.18\.000.*; only an edit of a library the main library alone includes is supported/);
  assert.deepEqual(filesIn(h.out), []);
  assert.equal(h.emits.length, 0, "refused before the terminology is expanded");
});

test("an edit that changes what a library retrieves has that library's data requirements recomputed, and is named in the manifest", async () => {
  // The CMS130v15 edit (`starts during` → `overlaps`) moves no retrieve: CMS's lists are carried and no
  // library is named (above, the manifest's keys). One that retrieves another value set gets its entries
  // edited: Advanced Illness's entry for that retrieve goes, a Frailty Diagnosis entry is appended.
  let h = harness({ compile: stubCompile(cms130.bundle as unknown as B, retrieveEdit).compile }, CMS130);
  assert.equal(await main(argsFor(h, [], [editOf(AIF, AIF_VERSION)]), h.deps), 0, h.errors.join("\n"));
  let manifest = readManifest(h);
  assert.deepEqual(Object.keys(manifest.derived!), ["label", "derivedFrom", "base", "build", "unchangedLibraries", "changedLibraries", "recomputedDataRequirements", "oracles"]);
  assert.deepEqual(manifest.derived!.recomputedDataRequirements, [AIF_WW], "only the library whose reads changed");
  let bundle = JSON.parse(readFileSync(join(h.out, "bundle.json"), "utf8")) as B;
  const cmsAif = librariesOf(cms130.bundle as unknown as B).find((l) => l["name"] === AIF)!;
  const ours = librariesOf(bundle).find((l) => l["name"] === AIF_WW)!;
  const entries = (library: Res, oid: string) => (library["dataRequirement"] as Res[]).filter((d) => JSON.stringify(d).includes(oid)).length;
  assert.equal(entries(ours, "113883.3.464.1003.110.12.1082"), entries(cmsAif, "113883.3.464.1003.110.12.1082") - 1);
  assert.equal(entries(ours, "113883.3.464.1003.113.12.1074"), entries(cmsAif, "113883.3.464.1003.113.12.1074") + 1);
  assert.ok(h.logs.some((l) => l === `cms130: data requirements recomputed for ${AIF_WW}: their reads differ from CMS's ELM for them`), h.logs.join("\n"));
  assert.deepEqual(derivedIdentityProblems(bundle, manifest, cms130), []);
  // It rebuilds byte for byte.
  assert.equal(await main(argsFor(h, ["--verify", "--skip-terminology"], [editOf(AIF, AIF_VERSION)]), h.deps), 0, h.errors.join("\n"));

  // The main library is WorkWell's compile even unedited, so it is held to the same rule: here its first
  // value set is declared under another canonical, and every list that named the old one now names the new.
  const { compile } = stubCompile();
  const OTHER = "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.0.0.0";
  let old = "";
  h = harness({
    compile: (sources, options) =>
      compile(sources, options).map((c) => {
        if (c.name !== MAIN) return c;
        const elm = JSON.parse(JSON.stringify(c.elm));
        const valueSets = elm.library.valueSets.def as Array<{ id: string }>;
        old = valueSets[0]!.id;
        valueSets[0]!.id = OTHER;
        return { ...c, elm };
      }),
  });
  assert.equal(await main(argsFor(h), h.deps), 0, h.errors.join("\n"));
  manifest = readManifest(h);
  assert.deepEqual(manifest.derived!.recomputedDataRequirements, ["WorkWellCMS137Translation2027"]);
  bundle = JSON.parse(readFileSync(join(h.out, "bundle.json"), "utf8")) as B;
  const mainText = JSON.stringify({ ...mainOf(bundle), content: undefined });
  assert.ok(old && !mainText.includes(`"${old}"`) && mainText.includes(OTHER), "no list still names the value set the ELM no longer declares");
  assert.deepEqual(derivedIdentityProblems(bundle, manifest, cms137), []);
});

test("a changed read the recompute cannot describe is refused, and nothing is written", async () => {
  // CMS's lists here hold no entry for the Advanced Illness retrieve the edit drops: there is nothing to
  // remove, so the list is not what the recompute believes it is.
  const altered = JSON.parse(JSON.stringify(cms130)) as OfficialArtifact;
  const aif = librariesOf(altered.bundle as unknown as B).find((l) => l["name"] === AIF)!;
  aif["dataRequirement"] = (aif["dataRequirement"] as Res[]).filter((d) => !JSON.stringify(d).includes("113883.3.464.1003.110.12.1082"));
  const h = harness({ compile: stubCompile(cms130.bundle as unknown as B, retrieveEdit).compile, loadBase: () => altered }, CMS130);
  assert.equal(await main(argsFor(h, [], [editOf(AIF, AIF_VERSION)]), h.deps), 1);
  assert.match(
    h.errors.join("\n"),
    /REFUSED — WorkWellAdvancedIllnessandFrailtyTranslation2027 ww-2027\.1: CMS's ELM retrieves Condition \(.*, value set .*110\.12\.1082\), which WorkWell's does not, but no dataRequirement entry describes that retrieve/,
  );
  assert.deepEqual(filesIn(h.out), []);
  assert.equal(h.emits.length, 0, "refused before the terminology is expanded");
});

test("the upstream hash, CMS's recorded options, the options applied and CMS's committed artifact are each required", async () => {
  let h = harness({
    verifyUpstream: () => {
      throw new Error("cms137: upstream bundle hashes to x, manifest pins y");
    },
  });
  assert.equal(await main(argsFor(h), h.deps), 1);
  assert.match(h.errors.join("\n"), /REFUSED — cms137: upstream bundle hashes to x, manifest pins y/);
  assert.equal(h.calls.length, 0);

  const otherOptions = upstreamBundle();
  const options = (mainOf(otherOptions)["contained"] as Array<{ id?: string; parameter: Array<{ name: string; valueString?: string }> }>).find((r) => r.id === "options")!;
  options.parameter.find((p) => p.name === "signatureLevel")!.valueString = "Overloads";
  h = harness({ load: () => ({ measureBundle: otherOptions as never }) });
  assert.equal(await main(argsFor(h), h.deps), 1);
  assert.match(h.errors.join("\n"), /was compiled with options this path does not reproduce: signatureLevel Overloads/);

  const { compile } = stubCompile();
  h = harness({
    compile: (sources, opts) =>
      compile(sources, opts).map((c) => (c.name === MAIN ? { ...c, elm: { library: { ...c.elm.library, annotation: [] } } } : c)),
  });
  assert.equal(await main(argsFor(h), h.deps), 1);
  assert.match(h.errors.join("\n"), /CMS137FHIRSUDTxInitEngagement 1\.0\.000: compiled with options \[\] at undefined, not CMS's/);

  h = harness({ loadBase: () => null });
  assert.equal(await main(argsFor(h), h.deps), 1);
  assert.match(h.errors.join("\n"), /CMS's artifact measures\/official\/cms137\/ is not committed/);
  assert.deepEqual(filesIn(h.out), []);
});

test("the router's identity check runs before anything is written", async () => {
  const h = harness();
  // A CMS host in the name the Measure's title is built from: the build must refuse its own output.
  assert.equal(await main(argsFor(h).map((a, i, all) => (all[i - 1] === "--derived-from" ? "madie.cms.gov" : a)), h.deps), 1);
  assert.match(h.errors.join("\n"), /identity would be refused:[\s\S]*title still names madie\.cms\.gov/);
  assert.deepEqual(filesIn(h.out), []);
});

test("the terminology block must be one JSON document describing the sidecar written beside it, at the release asked for", async () => {
  let h = harness({ runTerminologyEmit: () => "expanding…\n{}" });
  assert.equal(await main(argsFor(h), h.deps), 1);
  assert.match(h.errors.join("\n"), /stdout is not one JSON document/);

  h = harness({
    runTerminologyEmit: (request) => {
      writeFileSync(join(request.outputDir, "terminology.json"), `${SIDECAR_TEXT} `);
      return JSON.stringify(sidecarBlock());
    },
  });
  assert.equal(await main(argsFor(h), h.deps), 1);
  assert.match(h.errors.join("\n"), /the emitted terminology\.json hashes to sha256:[0-9a-f]{64}, but its block says/);
  assert.deepEqual(filesIn(h.out), []);

  h = harness({
    runTerminologyEmit: (request) => {
      writeFileSync(join(request.outputDir, "terminology.json"), SIDECAR_TEXT);
      return JSON.stringify({ ...sidecarBlock(), completion: { source: "vsac", manifest: "http://cts.nlm.nih.gov/fhir/Library/other", valueSets: [] } });
    },
  });
  assert.equal(await main(argsFor(h), h.deps), 1);
  assert.match(h.errors.join("\n"), /expanded at http:\/\/cts\.nlm\.nih\.gov\/fhir\/Library\/other, not the requested/);
});

test("--skip-terminology reuses the committed block, at the committed release only", async () => {
  let h = harness({ runTerminologyEmit: () => assert.fail("--skip-terminology must not expand") });
  assert.equal(await main(argsFor(h, ["--skip-terminology"]), h.deps), 1);
  assert.match(h.errors.join("\n"), /--skip-terminology takes the terminology block from the committed manifest, and there is none/);

  h = harness();
  assert.equal(await main(argsFor(h), h.deps), 0, h.errors.join("\n"));
  h.deps.runTerminologyEmit = () => assert.fail("--skip-terminology must not expand");
  assert.equal(await main(argsFor(h, ["--skip-terminology"]), h.deps), 0, h.errors.join("\n"));
  assert.deepEqual(readManifest(h).terminology, sidecarBlock());
  const other = argsFor(h, ["--skip-terminology"]).map((a, i, all) => (all[i - 1] === "--vsac-manifest" ? "http://cts.nlm.nih.gov/fhir/Library/other" : a));
  assert.equal(await main(other, h.deps), 1);
  assert.match(h.errors.join("\n"), /--vsac-manifest names http:\/\/cts\.nlm\.nih\.gov\/fhir\/Library\/other, but the committed terminology was expanded at/);
});

test("oracle records survive an identical rebuild and are cleared, loudly, by a changed one", async () => {
  const h = harness();
  assert.equal(await main(argsFor(h), h.deps), 0, h.errors.join("\n"));
  const manifest = readManifest(h);
  const record = { name: "cypress-deck", inputSha256: `sha256:${"c".repeat(64)}`, period: { start: "2025-01-01", end: "2025-12-31" }, agree: 1, total: 1, result: "pass", ranAgainst: { artifactSha256: manifest.sha256, terminologySha256: manifest.terminology!.sha256 } };
  writeFileSync(join(h.out, "manifest.json"), `${JSON.stringify({ ...manifest, derived: { ...manifest.derived, oracles: [record] } }, null, 2)}\n`);

  h.errors.length = 0;
  assert.equal(await main(argsFor(h), h.deps), 0, h.errors.join("\n"));
  assert.deepEqual(readManifest(h).derived!.oracles, [record]);
  assert.deepEqual(h.errors, []);

  const mainCql = standIn(MAIN, "1.0.000");
  const edit: CqlEdit = { library: MAIN, anchorSha256: spanSha256(mainCql, 5, 5), startLine: 5, endLine: 5, replacement: "define \"Two\": 20" };
  // The stubbed compile ignores the CQL, so make the bundle differ the way a real edit would.
  h.deps.compile = (sources, options) => {
    const compiled = stubCompile().compile(sources, options);
    (compiled.find((c) => c.name === MAIN)!.elm.library as Record<string, unknown>)["edited"] = true;
    return compiled;
  };
  assert.equal(await main(argsFor(h, [], [edit]), h.deps), 0, h.errors.join("\n"));
  assert.deepEqual(readManifest(h).derived!.oracles, []);
  assert.match(h.errors.join("\n"), /WARNING oracle records cleared: the artifact changed; re-run derived:check --record/);
});

// ---- --verify -------------------------------------------------------------------------------------------

test("--verify passes an exact rebuild, writes nothing, and fails on a single reordered key", async () => {
  const h = harness();
  assert.equal(await main(argsFor(h), h.deps), 0, h.errors.join("\n"));
  const stamp = () => filesIn(h.out).map((f) => `${f}:${statSync(join(h.out, f)).mtimeMs}:${sha(readFileSync(join(h.out, f)))}`);
  const before = stamp();
  const verify = (extra: string[] = []) => main(argsFor(h, ["--verify", ...extra]).filter((_, i, all) => all[i] !== "--package" && all[i - 1] !== "--package"), h.deps);

  assert.equal(await verify(), 0, h.errors.join("\n"));
  assert.equal(await verify(["--skip-terminology"]), 0, h.errors.join("\n"));
  assert.deepEqual(stamp(), before, "--verify writes nothing");

  // The same JSON with one key moved: equal as data, different as bytes, and the bytes are what is pinned.
  const bundlePath = join(h.out, "bundle.json");
  const original = readFileSync(bundlePath, "utf8");
  const { resourceType, ...rest } = JSON.parse(original) as Record<string, unknown>;
  writeFileSync(bundlePath, `${JSON.stringify({ ...rest, resourceType }, null, 0)}\n`);
  h.errors.length = 0;
  assert.equal(await verify(["--skip-terminology"]), 1);
  assert.match(h.errors.join("\n"), /bundle\.json: committed sha256:[0-9a-f]{64}, rebuilt sha256:[0-9a-f]{64}/);
  writeFileSync(bundlePath, original);

  // A committed manifest whose build record is not what the inputs rebuild: named by path, never by value.
  const manifest = readManifest(h);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const zeros = `sha256:${"0".repeat(64)}`;
  writeFileSync(join(h.out, "manifest.json"), `${JSON.stringify({ ...manifest, derived: { ...manifest.derived, build: { ...manifest.derived!.build, translationSha256: zeros } } }, null, 2)}\n`);
  h.errors.length = 0;
  assert.equal(await verify(["--skip-terminology"]), 1);
  assert.match(h.errors.join("\n"), /manifest\.json differs from the rebuild at: derived\.build\.translationSha256$/m);
  assert.ok(!h.errors.join("\n").includes(zeros), "the committed value is not printed");
  writeFileSync(join(h.out, "manifest.json"), manifestText);

  // A package given to --verify must be the one the translation records.
  h.errors.length = 0;
  assert.equal(await main([...argsFor(h, ["--verify", "--skip-terminology"]).filter((_, i, all) => all[i] !== "--package" && all[i - 1] !== "--package"), "--package", h.file("other.zip", "another package")], h.deps), 1);
  assert.match(h.errors.join("\n"), /manifest\.json differs from the rebuild at: derived\.derivedFrom\.packageSha256$/m);

  // A re-expansion that does not reproduce the committed block fails the verify.
  h.errors.length = 0;
  const emit = h.deps.runTerminologyEmit;
  h.deps.runTerminologyEmit = (request) => {
    writeFileSync(join(request.outputDir, "terminology.json"), SIDECAR_TEXT);
    return JSON.stringify({ ...sidecarBlock(), codes: 999 });
  };
  assert.equal(await verify(), 1);
  assert.match(h.errors.join("\n"), /manifest\.json differs from the rebuild at: terminology\.codes$/m);
  h.deps.runTerminologyEmit = emit;

  const empty = harness();
  mkdirSync(empty.out);
  assert.equal(await main(argsFor(empty, ["--verify"]), empty.deps), 1);
  assert.match(empty.errors.join("\n"), /nothing is committed at .+ to verify against/);
});

test("--verify compares the WHOLE manifest: a hand-edited label, key order or formatting fails it; carried records do not", async () => {
  const h = harness();
  assert.equal(await main(argsFor(h), h.deps), 0, h.errors.join("\n"));
  const manifestPath = join(h.out, "manifest.json");
  const verify = () => main(argsFor(h, ["--verify", "--skip-terminology"]).filter((_, i, all) => all[i] !== "--package" && all[i - 1] !== "--package"), h.deps);
  const write = (value: unknown, indent = 2) => writeFileSync(manifestPath, `${JSON.stringify(value, null, indent)}\n`);
  const built = readManifest(h);

  // Oracle records recorded since the build are carried by the rebuild, so the comparison still holds.
  const record = { name: "cypress-deck", inputSha256: `sha256:${"c".repeat(64)}`, period: { start: "2025-01-01", end: "2025-12-31" }, agree: 1, total: 1, result: "pass", ranAgainst: { artifactSha256: built.sha256, terminologySha256: built.terminology!.sha256 } };
  const recorded = { ...built, derived: { ...built.derived!, oracles: [record] } };
  write(recorded);
  assert.equal(await verify(), 0, h.errors.join("\n"));

  // The relabel: CMS's measure name as the label every screen shows. No field the old list compared moves.
  write({ ...recorded, derived: { ...recorded.derived, label: "CMS137v15" } });
  h.errors.length = 0;
  assert.equal(await verify(), 1);
  assert.match(h.errors.join("\n"), /manifest\.json differs from the rebuild at: derived\.label$/m);
  assert.ok(!h.errors.join("\n").includes("CMS137v15"), "the committed label is not printed");

  // Any other field the rebuild writes, e.g. the period the selector trusts.
  write({ ...recorded, effectivePeriod: { start: "2028-01-01", end: "2028-12-31" } });
  h.errors.length = 0;
  assert.equal(await verify(), 1);
  assert.match(h.errors.join("\n"), /at: effectivePeriod\.start, effectivePeriod\.end$/m);

  // Equal as data, different as bytes: reordered keys, then another indent.
  const { catalogId, ...rest } = recorded;
  write({ ...rest, catalogId });
  h.errors.length = 0;
  assert.equal(await verify(), 1);
  assert.match(h.errors.join("\n"), /manifest\.json differs from the rebuild at: \(top level\) \(key order\)/);
  write(recorded, 4);
  h.errors.length = 0;
  assert.equal(await verify(), 1);
  assert.match(h.errors.join("\n"), /manifest\.json differs from the rebuild only in its formatting/);

  write(recorded);
  assert.equal(await verify(), 0, "and restored, it verifies again");
});

// ---- the real thing -------------------------------------------------------------------------------------

const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const CONTENT_DIR = join(BACKEND, ".official-content");
const UPSTREAM = join(CONTENT_DIR, cms137.manifest.source.path);

// A plain skip, not promoted to a failure anywhere, and that is not a coverage hole: CI's official-cases
// job checks `.official-content` out and runs `pnpm build:derived --verify` on every committed translation
// ("Translation rebuild is reproducible" in ci.yml) — this same path, CMS's CQL through our translator,
// byte-compared with the committed files. This test is the local, uncommitted-output version of it.
test(
  "smoke: CMS's cms137 CQL compiled by our translator builds a translation the router accepts",
  { skip: existsSync(UPSTREAM) ? false : `CMS's upstream content is not checked out at ${UPSTREAM} (licensed, local-only: scripts/fetch-official-cases.ps1)`, timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "build-derived-smoke-"));
    const out = join(dir, "out");
    mkdirSync(out);
    // --skip-terminology takes the block from a committed manifest; this stand-in supplies one (no VSAC).
    const stub = { terminology: { ...cms137.manifest.terminology!, sha256: `sha256:${"d".repeat(64)}`, completion: { source: "vsac", manifest: RELEASE, valueSets: [] } } };
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify(stub, null, 2)}\n`);
    writeFileSync(join(dir, "edits.json"), "[]");
    writeFileSync(join(dir, "package.zip"), "a package stand-in");
    const errors: string[] = [];
    const code = await main(
      [
        "--catalog-id", "cms137", "--year", "2027", "--derived-from", "CMS137v15",
        "--edits", join(dir, "edits.json"), "--package", join(dir, "package.zip"),
        "--vsac-manifest", RELEASE, "--skip-terminology",
        "--content-dir", CONTENT_DIR, "--output-dir", out,
      ],
      { log: () => {}, error: (m) => errors.push(m) },
    );
    assert.equal(code, 0, errors.join("\n"));

    const bundle = JSON.parse(readFileSync(join(out, "bundle.json"), "utf8")) as B;
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as OfficialManifest;
    assert.deepEqual(derivedIdentityProblems(bundle, manifest, cms137), []);
    const mainElm = Buffer.from(elmDataOf(mainOf(bundle)), "base64").toString("utf8");
    assert.ok(!/madie/i.test(mainElm), "our compile of the main library names no CMS host");
    assert.ok(!/"(annotation|locator)":/.test(mainElm), "and carries none of CMS's CQL text or positions");
    assert.ok(/"localId":/.test(mainElm), "but keeps the localIds fqm reads define values by");
    const cmsMainName = String(mainOf(baseBundle)["name"]);
    const shared = librariesOf(baseBundle).filter((l) => l["name"] !== cmsMainName);
    assert.equal(shared.length, 6);
    for (const library of shared) {
      const ours = librariesOf(bundle).find((l) => l["name"] === library["name"]);
      assert.equal(ours && elmDataOf(ours), elmDataOf(library), `${String(library["name"])} is CMS's ELM, byte for byte`);
    }
  },
);
