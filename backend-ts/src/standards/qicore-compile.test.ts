/**
 * The QI-Core compile path's own guarantees, without the network or `.official-content`: the model info
 * is the pinned file or nothing, includes resolve by exact version, CMS's recorded options are checked
 * rather than assumed (and so are the options our compile applied), and an unexpected warning fails the
 * compile. The end-to-end proof (CMS's decks on our ELM) is `pnpm test:compiled-cases`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CMS_TRANSLATOR_OPTIONS,
  QICORE_MODEL_INFO,
  assertAppliedOptions,
  assertCmsTranslatorOptions,
  bundleLibraries,
  compileLibrarySet,
  loadQiCoreModelInfos,
  verifiedModelInfo,
  withCompiledElm,
} from "./qicore-compile.ts";
import { QICORE_MODEL_INFO_SHA256 } from "./derived-identity.ts";

const MODEL_INFO = new URL(`../../measures/derived/_modelinfo/${QICORE_MODEL_INFO.file}`, import.meta.url);
const models = loadQiCoreModelInfos();

const TINY = `library TinyQICore version '0.0.1'
using QICore version '6.0.0'
context Patient
define "Has Birth Date": Patient.birthDate is not null
`;
const WITH_INCLUDE = TINY.replace("context Patient", "include Helper version '1.0.0' called Helper\ncontext Patient");
const HELPER = { name: "Helper", version: "1.0.0", cql: "library Helper version '1.0.0'\ndefine \"One\": 1\n" };

test("the QICore model info is the pinned file, whatever line endings the checkout gave it", () => {
  assert.deepEqual(models.map((m) => `${m.name}@${m.version}`), ["System@1.0.0", "FHIR@4.0.1", "QICore@6.0.0"]);
  const dir = mkdtempSync(join(tmpdir(), "qicore-mi-"));
  const crlf = join(dir, "crlf.xml");
  // \r?\n, not \n: on a CRLF checkout the file is CRLF already, and the fixture must not become \r\r\n.
  writeFileSync(crlf, readFileSync(MODEL_INFO, "utf8").replace(/\r?\n/g, "\r\n"));
  assert.doesNotThrow(() => verifiedModelInfo(crlf, QICORE_MODEL_INFO.sha256));

  const edited = join(dir, "edited.xml");
  writeFileSync(edited, readFileSync(MODEL_INFO, "utf8").replace('version="6.0.0"', 'version="6.0.1"'));
  assert.throws(() => verifiedModelInfo(edited, QICORE_MODEL_INFO.sha256), /refusing to compile against it/);
  assert.throws(() => loadQiCoreModelInfos(edited), /refusing to compile against it/);
});

test("a QI-Core 6 library compiles against the QICore model info, with CMS's options applied", () => {
  const [compiled] = compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: TINY }], { modelInfos: models });
  assert.ok(compiled);
  assert.equal(compiled.elm.library.identifier.id, "TinyQICore");
  // CMS's own ELM records the QICore using with its target URI and no version; ours must too.
  const usings = (compiled.elm.library.usings as { def: { localIdentifier: string; uri?: string; version?: string }[] }).def;
  assert.ok(usings.some((u) => u.localIdentifier === "QICore" && u.uri === "http://hl7.org/fhir" && u.version === undefined));
  assert.deepEqual(compiled.warnings, []);
  const info = (compiled.elm.library.annotation as { type?: string; translatorOptions?: string; signatureLevel?: string }[]).find(
    (a) => a.type === "CqlToElmInfo",
  );
  assert.deepEqual(String(info?.translatorOptions).split(",").sort(), [...CMS_TRANSLATOR_OPTIONS.options].sort());
  assert.equal(info?.signatureLevel, "All");
});

test("a compile whose recorded options are not CMS's is refused", () => {
  const elm = (translatorOptions: string, signatureLevel: string) => ({
    library: { annotation: [{ type: "CqlToElmInfo", translatorOptions, signatureLevel }] },
  });
  const cms = CMS_TRANSLATOR_OPTIONS.options.join(",");
  assert.doesNotThrow(() => assertAppliedOptions(elm(cms, "All"), "All", "L"));
  assert.throws(() => assertAppliedOptions(elm(cms.replace(",DisableListPromotion", ""), "All"), "All", "L"), /not CMS's/);
  assert.throws(() => assertAppliedOptions(elm(cms, "Overloads"), "All", "L"), /at Overloads, not CMS's/);
  assert.throws(() => assertAppliedOptions({ library: {} }, "All", "L"), /not CMS's/);
});

test("every signature level the type allows compiles, None (ordinal 0) included", () => {
  for (const signatureLevel of ["None", "Differing", "Overloads", "All"] as const) {
    assert.equal(compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: TINY }], { modelInfos: models, signatureLevel }).length, 1, signatureLevel);
  }
});

test("a library whose CQL declares another identity is refused", () => {
  assert.throws(() => compileLibrarySet([{ name: "TinyQICore", version: "0.0.2", cql: TINY }], { modelInfos: models }), /compiled to TinyQICore 0\.0\.1/);
});

test("a model or an include resolves only by exact version", () => {
  // A different model version is refused (by the translator), and so is a different include version
  // (by our library provider, which would otherwise hand over the wrong file).
  assert.throws(
    () => compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: TINY.replace("'6.0.0'", "'7.0.0'") }], { modelInfos: models }),
    /Could not load model information for model QICore, version 7\.0\.0/,
  );
  const wrongVersion = { ...HELPER, version: "1.0.1", cql: HELPER.cql.replace("1.0.0", "1.0.1") };
  assert.throws(
    () => compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: WITH_INCLUDE }, wrongVersion], { modelInfos: models }),
    /Could not load source for library Helper, version 1\.0\.0/,
  );
  assert.equal(compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: WITH_INCLUDE }, HELPER], { modelInfos: models }).length, 2);
});

test("a warning outside the known list fails the compile", () => {
  const hiding = `${TINY}define "x": 1\ndefine function F(x Integer): x + 1\n`;
  assert.throws(
    () => compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: hiding }], { modelInfos: models, knownWarnings: {} }),
    /unexpected translator warnings/,
  );
  const known = { TinyQICore: ["An operand identifier x is hiding another identifier of the same name."] };
  assert.equal(compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: hiding }], { modelInfos: models, knownWarnings: known }).length, 1);
});

const optionsLibrary = (overrides: Record<string, string | boolean> = {}, options: string[] = [...CMS_TRANSLATOR_OPTIONS.options]) => ({
  name: "L",
  contained: [
    {
      resourceType: "Parameters",
      id: "options",
      parameter: [
        { name: "translatorVersion", valueString: "3.27.0" },
        ...options.map((o) => ({ name: "option", valueString: o })),
        { name: "signatureLevel", valueString: overrides.signatureLevel ?? "All" },
        { name: "compatibilityLevel", valueString: overrides.compatibilityLevel ?? "1.5" },
        { name: "errorLevel", valueString: overrides.errorLevel ?? "Info" },
        { name: "validateUnits", valueBoolean: overrides.validateUnits ?? true },
      ],
    },
  ],
});

test("CMS's recorded translator options are checked, not assumed", () => {
  assert.doesNotThrow(() => assertCmsTranslatorOptions(optionsLibrary()));
  assert.throws(() => assertCmsTranslatorOptions(optionsLibrary({ signatureLevel: "Overloads" })), /signatureLevel Overloads/);
  assert.throws(() => assertCmsTranslatorOptions(optionsLibrary({ compatibilityLevel: "2.0" })), /compatibilityLevel 2\.0/);
  assert.throws(() => assertCmsTranslatorOptions(optionsLibrary({ errorLevel: "Warning" })), /errorLevel Warning/);
  assert.throws(() => assertCmsTranslatorOptions(optionsLibrary({ validateUnits: false })), /validateUnits false/);
  assert.throws(
    () => assertCmsTranslatorOptions(optionsLibrary({}, CMS_TRANSLATOR_OPTIONS.options.filter((o) => o !== "EnableResultTypes"))),
    /options \[/,
  );
  assert.throws(() => assertCmsTranslatorOptions({ name: "L" }), /no contained "options"/);
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
const libraryEntry = (name: string, version: string, cql: string) => ({
  resource: {
    resourceType: "Library",
    name,
    version,
    content: [
      { contentType: "text/cql", data: b64(cql) },
      { contentType: "application/elm+json", data: b64(JSON.stringify({ library: { identifier: { id: name, version }, upstream: true } })) },
    ],
  },
});

test("the compiled bundle carries our ELM alone, for every library, so nothing can fall back to CMS's", () => {
  const bundle = {
    entry: [{ resource: { resourceType: "Measure", id: "m" } }, libraryEntry("TinyQICore", "0.0.1", WITH_INCLUDE), libraryEntry("Helper", "1.0.0", HELPER.cql)],
  };
  const sources = bundleLibraries(bundle);
  assert.deepEqual(sources.map((s) => `${s.name}@${s.version}`), ["TinyQICore@0.0.1", "Helper@1.0.0"]);
  const compiled = compileLibrarySet(sources, { modelInfos: models });
  const out = withCompiledElm(bundle, compiled);
  for (const [i, ours] of compiled.entries()) {
    const library = out.entry[i + 1]?.resource as { content: { contentType: string; data: string }[] };
    assert.deepEqual(library.content.map((c) => c.contentType), ["application/elm+json"]);
    const written = JSON.parse(unb64(library.content[0]?.data ?? ""));
    assert.deepEqual(written, ours.elm, `${ours.name} carries our ELM, not upstream's`);
    assert.equal(written.library.upstream, undefined);
  }
  assert.equal((bundle.entry[1]?.resource as { content: unknown[] }).content.length, 2, "the input bundle is not modified");
  assert.throws(() => withCompiledElm(bundle, compiled.slice(0, 1)), /no compiled ELM for Library Helper 1\.0\.0/);
});

test("a Library without both its CQL and its ELM is refused", () => {
  const entry = libraryEntry("TinyQICore", "0.0.1", TINY);
  (entry.resource.content as unknown[]).splice(0, 1);
  assert.throws(() => bundleLibraries({ entry: [entry] }), /lacks text\/cql or application\/elm\+json/);
});

test("the router's copy of the model-info pin is this pin", () => {
  // derived-identity.ts repeats the hash because importing this module would load the translator into
  // the worker; this is what keeps the repeat from drifting.
  assert.equal(QICORE_MODEL_INFO_SHA256, QICORE_MODEL_INFO.sha256);
});

test("compiling the same source twice yields byte-identical ELM, which build:derived requires", () => {
  const once = compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: WITH_INCLUDE }, HELPER], { modelInfos: models });
  const again = compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: WITH_INCLUDE }, HELPER], { modelInfos: models });
  assert.equal(JSON.stringify(again[0]!.elm), JSON.stringify(once[0]!.elm));
});
