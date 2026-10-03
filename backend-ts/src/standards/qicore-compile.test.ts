/**
 * The QI-Core compile path's own guarantees, without the network or `.official-content`: the model info
 * is the pinned file or nothing, models and includes resolve by exact version, CMS's recorded options are
 * checked rather than assumed, and an unexpected warning fails the compile. The end-to-end proof (CMS's
 * decks on our ELM) is `pnpm test:compiled-cases`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CMS_TRANSLATOR_OPTIONS,
  QICORE_MODEL_INFO,
  assertCmsTranslatorOptions,
  bundleLibraries,
  compileLibrarySet,
  loadQiCoreModelInfos,
  verifiedModelInfo,
  withCompiledElm,
} from "./qicore-compile.ts";

const MODEL_INFO = new URL(`../../measures/derived/_modelinfo/${QICORE_MODEL_INFO.file}`, import.meta.url);
const models = loadQiCoreModelInfos();

const TINY = `library TinyQICore version '0.0.1'
using QICore version '6.0.0'
context Patient
define "Has Birth Date": Patient.birthDate is not null
`;

test("the QICore model info is the pinned file, whatever line endings the checkout gave it", () => {
  assert.deepEqual(models.map((m) => `${m.name}@${m.version}`), ["System@1.0.0", "FHIR@4.0.1", "QICore@6.0.0"]);
  const dir = mkdtempSync(join(tmpdir(), "qicore-mi-"));
  const crlf = join(dir, "crlf.xml");
  writeFileSync(crlf, readFileSync(MODEL_INFO, "utf8").replace(/\n/g, "\r\n"));
  assert.doesNotThrow(() => verifiedModelInfo(crlf, QICORE_MODEL_INFO.sha256));

  const edited = join(dir, "edited.xml");
  writeFileSync(edited, readFileSync(MODEL_INFO, "utf8").replace('version="6.0.0"', 'version="6.0.1"'));
  assert.throws(() => verifiedModelInfo(edited, QICORE_MODEL_INFO.sha256), /refusing to compile against it/);
  assert.throws(() => loadQiCoreModelInfos(edited), /refusing to compile against it/);
});

test("a QI-Core 6 library compiles against the QICore model info", () => {
  const [compiled] = compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: TINY }], { modelInfos: models });
  assert.ok(compiled);
  assert.equal(compiled.elm.library.identifier.id, "TinyQICore");
  // CMS's own ELM records the QICore using with its target URI and no version; ours must too.
  const usings = (compiled.elm.library.usings as { def: { localIdentifier: string; uri?: string; version?: string }[] }).def;
  assert.ok(usings.some((u) => u.localIdentifier === "QICore" && u.uri === "http://hl7.org/fhir" && u.version === undefined));
  assert.deepEqual(compiled.warnings, []);
});

test("a model or an include resolves only by exact version", () => {
  // A different model version is refused (by the translator), and so is a different include version
  // (by our library provider, which would otherwise hand over the wrong file).
  assert.throws(
    () => compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: TINY.replace("'6.0.0'", "'7.0.0'") }], { modelInfos: models }),
    /Could not load model information for model QICore, version 7\.0\.0/,
  );
  const withInclude = TINY.replace("context Patient", "include Helper version '1.0.0' called Helper\ncontext Patient");
  const helper = { name: "Helper", version: "1.0.1", cql: "library Helper version '1.0.1'\ndefine \"One\": 1\n" };
  assert.throws(
    () => compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: withInclude }, helper], { modelInfos: models }),
    /Could not load source for library Helper, version 1\.0\.0/,
  );
  const exact = { ...helper, version: "1.0.0", cql: helper.cql.replace("1.0.1", "1.0.0") };
  assert.equal(compileLibrarySet([{ name: "TinyQICore", version: "0.0.1", cql: withInclude }, exact], { modelInfos: models }).length, 2);
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
  assert.throws(
    () => assertCmsTranslatorOptions(optionsLibrary({}, CMS_TRANSLATOR_OPTIONS.options.filter((o) => o !== "EnableResultTypes"))),
    /options/,
  );
  assert.throws(() => assertCmsTranslatorOptions({ name: "L" }), /no contained "options"/);
});

test("the compiled bundle carries our ELM alone, so nothing can fall back to CMS's", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const bundle = {
    entry: [
      { resource: { resourceType: "Measure", id: "m" } },
      {
        resource: {
          resourceType: "Library",
          name: "TinyQICore",
          version: "0.0.1",
          content: [
            { contentType: "text/cql", data: b64(TINY) },
            { contentType: "application/elm+json", data: b64('{"library":{"identifier":{"id":"TinyQICore"}}}') },
          ],
        },
      },
    ],
  };
  const [source] = bundleLibraries(bundle);
  assert.ok(source);
  const compiled = compileLibrarySet([source], { modelInfos: models });
  const out = withCompiledElm(bundle, compiled);
  const library = out.entry[1]?.resource as { content: { contentType: string }[] };
  assert.deepEqual(library.content.map((c) => c.contentType), ["application/elm+json"]);
  assert.equal((bundle.entry[1]?.resource as { content: unknown[] }).content.length, 2, "the input bundle is not modified");
  assert.throws(() => withCompiledElm(bundle, []), /no compiled ELM for Library TinyQICore/);
});
