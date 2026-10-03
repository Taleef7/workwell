/**
 * Compile CMS's QI-Core 6 measure CQL to ELM with the pinned pure-JS translator — the compile path the
 * 2027 translations build on (they change CMS's CQL, so they must compile it, not vendor CMS's ELM).
 *
 * BUILD/DIAGNOSTIC ONLY: reached from CLIs (`pnpm test:compiled-cases`), never from the worker, a route
 * or the run pipeline. It reads its inputs from disk; nothing here is bundled.
 *
 * ## Why this is trustworthy
 *
 * The translator is the same `@cqframework/cql@4.0.0-beta.1` the authored measures compile with. The only
 * extra input is cqframework's QICore 6.0.0 model info — the file CMS's own translator (Java 3.27.0)
 * ships — and the options are exactly the `cqf-cqlOptions` CMS recorded on each Library. The proof is
 * not byte-equal ELM (a different translator build cannot produce that) but equal RESULTS: the
 * calibration gate (`run/cli/compiled-cases.ts`) runs CMS's MADiE decks on our ELM and on CMS's and
 * requires every case, rate, stratifier and define value to agree.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ModelManager,
  LibraryManager,
  CqlTranslator,
  CqlCompilerOptions,
  LibraryBuilder,
  createModelInfoProvider,
  createLibrarySourceProvider,
  createUcumService,
  stringAsSource,
  // @ts-expect-error — @cqframework/cql ships its own bundled types via subpath
} from "@cqframework/cql/cql-to-elm";
import { convertUnit, validateUnit } from "../measure/ucum.ts";

const RESOURCES = new URL("../measure/resources/", import.meta.url);
const MODEL_INFO_DIR = new URL("../../measures/derived/_modelinfo/", import.meta.url);

/** CRLF → LF: a Windows checkout converts line endings, and the pinned hash is of the LF bytes. */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface ModelInfoFile {
  name: string;
  version: string;
  xml: string;
}

/**
 * cqframework's QICore 6.0.0 model info, Apache-2.0, byte-identical to
 * `Src/java/quick/src/main/resources/org/hl7/fhir/qicore-modelinfo-6.0.0.xml` at tag v3.27.0 (git blob
 * `fead944520e61f3010a54b2a4e8a0b507ad4c58f`) — the translator release CMS compiled the 2026 drafts with.
 * NOT the IG package's `Library-QICore-ModelInfo.json`, an older revision that differs in three types.
 */
export const QICORE_MODEL_INFO = {
  name: "QICore",
  version: "6.0.0",
  file: "qicore-modelinfo-6.0.0.xml",
  sha256: "75cf34cca8b6ce28f0841201681ff6f2db2235cdcd4ad39bd84c01b8ea76ad33",
} as const;

/** Read a model info file and refuse it unless its LF-normalized bytes hash to `expected`. */
export function verifiedModelInfo(path: URL | string, expected: string): string {
  const xml = lf(readFileSync(path, "utf8"));
  const actual = sha256(xml);
  if (actual !== expected) {
    throw new Error(`model info ${String(path)} hashes to ${actual}, expected ${expected}; refusing to compile against it`);
  }
  return xml;
}

/** System 1.0.0 and FHIR 4.0.1 (the files the authored build uses) plus the verified QICore 6.0.0. */
export function loadQiCoreModelInfos(qiCorePath: URL | string = new URL(QICORE_MODEL_INFO.file, MODEL_INFO_DIR)): ModelInfoFile[] {
  return [
    { name: "System", version: "1.0.0", xml: lf(readFileSync(new URL("system-modelinfo.xml", RESOURCES), "utf8")) },
    { name: "FHIR", version: "4.0.1", xml: lf(readFileSync(new URL("fhir-modelinfo-4.0.1.xml", RESOURCES), "utf8")) },
    { name: QICORE_MODEL_INFO.name, version: QICORE_MODEL_INFO.version, xml: verifiedModelInfo(qiCorePath, QICORE_MODEL_INFO.sha256) },
  ];
}

/**
 * CMS's recorded translator options (the `cqf-cqlOptions` Parameters on every upstream Library): the
 * translator defaults (EnableAnnotations, EnableLocators, DisableListDemotion, DisableListPromotion),
 * plus EnableResultTypes, at signature level All. errorLevel Info, compatibility 1.5 and validateUnits
 * are the defaults already.
 */
export const CMS_TRANSLATOR_OPTIONS = {
  options: ["EnableAnnotations", "EnableLocators", "EnableResultTypes", "DisableListDemotion", "DisableListPromotion"],
  signatureLevel: "All",
  compatibilityLevel: "1.5",
  errorLevel: "Info",
  validateUnits: true,
} as const;

export type SignatureLevel = "None" | "Differing" | "Overloads" | "All";

interface FhirParameter {
  name?: string;
  valueString?: string;
  valueBoolean?: boolean;
}

/**
 * The options an upstream Library says it was compiled with, read from its contained `options`
 * Parameters. Throws when they are not CMS_TRANSLATOR_OPTIONS — an upstream change must be noticed
 * before our ELM is compared with theirs, not discovered as an unexplained mismatch.
 */
export function assertCmsTranslatorOptions(library: { name?: string; contained?: unknown[] }): void {
  const params = (library.contained ?? []).find(
    (resource) => (resource as { resourceType?: string; id?: string }).resourceType === "Parameters" && (resource as { id?: string }).id === "options",
  ) as { parameter?: FhirParameter[] } | undefined;
  if (!params) throw new Error(`Library ${library.name}: no contained "options" Parameters to check the translator options against`);
  const all = params.parameter ?? [];
  const value = (name: string) => all.find((p) => p.name === name);
  const options = all.filter((p) => p.name === "option").map((p) => p.valueString).sort();
  const want = [...CMS_TRANSLATOR_OPTIONS.options].sort();
  const problems: string[] = [];
  if (JSON.stringify(options) !== JSON.stringify(want)) problems.push(`options ${JSON.stringify(options)}`);
  if (value("signatureLevel")?.valueString !== CMS_TRANSLATOR_OPTIONS.signatureLevel) problems.push(`signatureLevel ${value("signatureLevel")?.valueString}`);
  if (value("compatibilityLevel")?.valueString !== CMS_TRANSLATOR_OPTIONS.compatibilityLevel) problems.push(`compatibilityLevel ${value("compatibilityLevel")?.valueString}`);
  if (value("errorLevel")?.valueString !== CMS_TRANSLATOR_OPTIONS.errorLevel) problems.push(`errorLevel ${value("errorLevel")?.valueString}`);
  if (value("validateUnits")?.valueBoolean !== CMS_TRANSLATOR_OPTIONS.validateUnits) problems.push(`validateUnits ${value("validateUnits")?.valueBoolean}`);
  if (problems.length > 0) {
    throw new Error(`Library ${library.name} was compiled with options this path does not reproduce: ${problems.join("; ")}`);
  }
}

/**
 * The warnings CMS's own shared libraries produce under this translator (identifier hiding, same as
 * upstream's Java build). Any other warning fails the compile: a silent warning is how a changed
 * meaning would slip through.
 */
export const KNOWN_WARNINGS: Readonly<Record<string, readonly string[]>> = {
  FHIRHelpers: [
    "An operand identifier reference is hiding another identifier of the same name.",
    "An operand identifier reference is hiding another identifier of the same name.",
    "An operand identifier reference is hiding another identifier of the same name.",
  ],
  QICoreCommon: [
    "An operand identifier references is hiding another identifier of the same name.",
    "An operand identifier references is hiding another identifier of the same name.",
  ],
  CQMCommon: ["An operand identifier encounter is hiding another identifier of the same name."],
};

/**
 * What the translator says it APPLIED (it records CqlToElmInfo on every library), checked against CMS's
 * set, so a translator whose defaults moved cannot compile with other options while the metadata check on
 * CMS's side still passes.
 */
export function assertAppliedOptions(elm: { library: Record<string, unknown> }, signatureLevel: SignatureLevel, label: string): void {
  const info = ((elm.library.annotation ?? []) as { type?: string; translatorOptions?: string; signatureLevel?: string }[]).find(
    (a) => a.type === "CqlToElmInfo",
  );
  const applied = String(info?.translatorOptions ?? "").split(",").filter(Boolean).sort();
  if (JSON.stringify(applied) !== JSON.stringify([...CMS_TRANSLATOR_OPTIONS.options].sort()) || info?.signatureLevel !== signatureLevel) {
    throw new Error(`${label}: compiled with options ${JSON.stringify(applied)} at ${info?.signatureLevel}, not CMS's`);
  }
}

export interface LibrarySource {
  name: string;
  version: string;
  cql: string;
}

export interface CompiledLibrary {
  name: string;
  version: string;
  /** The ELM JSON as the translator produced it (annotations, locators and localIds included). */
  elm: { library: Record<string, unknown> & { identifier: { id: string; version?: string } } };
  warnings: string[];
}

interface ElmAnnotation {
  errorSeverity?: string;
  message?: string;
}

export interface CompileOptions {
  modelInfos?: ModelInfoFile[];
  signatureLevel?: SignatureLevel;
  /** Defaults to KNOWN_WARNINGS; a test passes its own to prove an unexpected warning fails. */
  knownWarnings?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Compile every library in `sources`. Includes resolve only within `sources`, by exact name and version;
 * models resolve only to the given files (the translator rejects a version that differs from the `using`). Throws on any translator error and on any
 * warning not in `knownWarnings` for that library.
 */
export function compileLibrarySet(sources: readonly LibrarySource[], options: CompileOptions = {}): CompiledLibrary[] {
  const modelInfos = options.modelInfos ?? loadQiCoreModelInfos();
  const signatureName = options.signatureLevel ?? CMS_TRANSLATOR_OPTIONS.signatureLevel;
  const signature = LibraryBuilder.SignatureLevel[signatureName];
  if (!signature) throw new Error(`unknown signature level ${options.signatureLevel}`);
  const knownWarnings = options.knownWarnings ?? KNOWN_WARNINGS;

  const manager = (): unknown => {
    const mm = new ModelManager();
    mm.modelInfoLoader.registerModelInfoProvider(
      // By name: the translator itself refuses a model whose version differs from the `using`
      // (pinned by the unit test), so a second check here could never fire.
      createModelInfoProvider((name: string) => {
        const model = modelInfos.find((m) => m.name === name);
        return model ? stringAsSource(model.xml) : null;
      }),
    );
    const compilerOptions = CqlCompilerOptions.defaultOptions()
      .withOptions([CqlCompilerOptions.Options.EnableResultTypes])
      .withSignatureLevel(signature);
    // Positional: (modelManager, cqlCompilerOptions, libraryCache, lazyUcumService). The same UCUM
    // functions `scripts/compile-measures.mjs` uses; without them a quantity literal cannot compile.
    const lm = new LibraryManager(mm, compilerOptions, undefined, createUcumService(convertUnit, validateUnit));
    lm.librarySourceLoader.registerProvider(
      createLibrarySourceProvider((name: string, _system: string | null, version: string | null) => {
        const source = sources.find((s) => s.name === name && (!version || s.version === version));
        return source ? stringAsSource(source.cql) : null;
      }),
    );
    return lm;
  };

  return sources.map((source) => {
    const translator = CqlTranslator.fromText(source.cql, manager());
    const elm = JSON.parse(translator.toJson()) as CompiledLibrary["elm"];
    assertAppliedOptions(elm, signatureName, `${source.name} ${source.version}`);
    const annotations = ((elm.library.annotation ?? []) as ElmAnnotation[]).filter((a) => a.errorSeverity);
    const errors = annotations.filter((a) => a.errorSeverity === "error").map((a) => a.message ?? "");
    if (errors.length > 0) {
      throw new Error(`${source.name} ${source.version}: ${errors.length} translator error(s): ${errors.slice(0, 5).join(" | ")}`);
    }
    const warnings = annotations.filter((a) => a.errorSeverity === "warning").map((a) => a.message ?? "");
    const expected = [...(knownWarnings[source.name] ?? [])].sort();
    if (JSON.stringify([...warnings].sort()) !== JSON.stringify(expected)) {
      throw new Error(
        `${source.name} ${source.version}: unexpected translator warnings ${JSON.stringify(warnings)} (known: ${JSON.stringify(expected)})`,
      );
    }
    const id = elm.library.identifier;
    if (id.id !== source.name || id.version !== source.version) {
      throw new Error(`${source.name} ${source.version} compiled to ${id.id} ${id.version}`);
    }
    return { name: source.name, version: source.version, elm, warnings };
  });
}

interface BundleLike {
  entry?: { resource?: Record<string, unknown> }[];
}

interface LibraryContent {
  contentType?: string;
  data?: string;
}

const decode = (data: string): string => Buffer.from(data, "base64").toString("utf8");

/** Every Library in a measure bundle, with its CQL source (LF) and the ELM JSON upstream shipped. */
export function bundleLibraries(bundle: BundleLike): (LibrarySource & { resource: Record<string, unknown>; upstreamElm: unknown })[] {
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is Record<string, unknown> => resource?.resourceType === "Library")
    .map((resource) => {
      const content = (resource.content ?? []) as LibraryContent[];
      const cql = content.find((c) => c.contentType === "text/cql")?.data;
      const elm = content.find((c) => c.contentType === "application/elm+json")?.data;
      if (!cql || !elm) throw new Error(`Library ${String(resource.name)} lacks text/cql or application/elm+json`);
      return {
        name: String(resource.name),
        version: String(resource.version),
        cql: lf(decode(cql)),
        resource,
        upstreamElm: JSON.parse(decode(elm)),
      };
    });
}

/**
 * The measure bundle with each Library's content replaced by OUR ELM alone. No `text/cql` survives, so
 * nothing downstream can fall back to CMS's ELM or re-translate; the ValueSets and the Measure stay.
 */
export function withCompiledElm<T extends BundleLike>(bundle: T, compiled: readonly CompiledLibrary[]): T {
  const copy = JSON.parse(JSON.stringify(bundle)) as T;
  for (const entry of copy.entry ?? []) {
    const resource = entry.resource;
    if (resource?.resourceType !== "Library") continue;
    const ours = compiled.find((c) => c.name === resource.name && c.version === resource.version);
    if (!ours) throw new Error(`no compiled ELM for Library ${String(resource.name)} ${String(resource.version)}`);
    resource.content = [{ contentType: "application/elm+json", data: Buffer.from(JSON.stringify(ours.elm), "utf8").toString("base64") }];
  }
  return copy;
}
