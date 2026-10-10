/**
 * The identity a WorkWell translation carries, and the check that it carries no other.
 *
 * A translation (decision 3, 2026-10-02) is CMS's measure with WorkWell's edits, compiled by WorkWell.
 * LOCKED §4.3 forbids putting a CMS measure identity over counts that logic did not produce, so the
 * translated Measure and every library WorkWell changed get WorkWell names, a WorkWell canonical and a
 * WorkWell version, and point back at the CMS measure only through a `derived-from` link. CMS's shared
 * libraries that WorkWell did NOT change keep CMS's names: renaming them would present CMS's untouched
 * work as WorkWell's. Each of those is pinned by the hash of its ELM, so "unchanged" is checked, not
 * asserted.
 *
 * A CMS shared library WorkWell EDITED (#779, CMS130's AdvancedIllnessandFrailty) is a changed library:
 * WorkWell's name, canonical and `ww-` version, and a `changedLibraries` record naming the CMS library it
 * was edited from by name, version and the hash of CMS's ELM — checked against CMS's committed artifact,
 * as "unchanged" is, and refused while CMS's copy still rides in the bundle beside it. So every library
 * besides the main one is accounted for exactly once: carried unchanged, or changed and traced to CMS's.
 *
 * Which libraries the translation IS, is decided the way the engine decides it: from the main library,
 * every ELM include is resolved by fqm's rule (`includedLibraryName`) to exactly one library in the
 * bundle, and the libraries reached must be the bundle's libraries. An include left at CMS's library, a
 * `urn:` path the engine cannot resolve, and CMS's library left beside WorkWell's copy each fail here,
 * at router construction, rather than as a missing define on the first evaluation.
 *
 * And what each library says it READS must be what its ELM declares (D10, #782). fqm collects the value
 * sets every library's `relatedArtifact` and `dataRequirement` name and refuses to evaluate while any of
 * them is missing from its cache, which a translation builds from ELM declarations; so a library whose
 * lists still name a value set its edited logic dropped fails every evaluation, and one whose lists miss
 * a set it declares asserts data requirements its logic does not have. Both are refused here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DerivedChangedLibrary, DerivedManifestBlock, OfficialManifest } from "../wiring/official-artifacts.ts";
// A cycle (that module imports DERIVED_LIBRARY_PREFIX from this one), safe because neither module reads
// the other's bindings at load time. One rule for the builder that writes an include and the check that
// resolves it, so the two cannot disagree about what the engine will find.
import { includedLibraryName } from "./derived-changed-library.ts";

export const DERIVED_CANONICAL_PREFIX = "urn:workwell:measure:";
export const DERIVED_LIBRARY_PREFIX = "urn:workwell:library:";
/** `ww-<year>.<n>`: never confusable with CMS's `1.0.000` or the QDM measure's `15.0.000`. */
export const DERIVED_VERSION = /^ww-\d{4}\.\d+$/;
const FORBIDDEN_IDENTIFIER_TYPES = new Set(["short-name", "version-specific", "version-independent", "publisher"]);
const CMS_HOST = "madie.cms.gov";
/** A refusal, not a sanitizer: CMS's authoring host named ANYWHERE in a field fails the field. */
const NAMES_CMS_HOST = /madie\.cms\.gov/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
/**
 * The ELM keys that carry CQL source: `annotation` holds the CQL text itself (the `s` narrative) and
 * `locator` its line/column positions. `localId` is NOT one of them — it is a bare node number carrying no
 * CQL, and fqm resolves every define's value by it (stripped, every `raw` reads null, and the MADiE
 * define-value check cannot run on a translation). So a translation keeps it.
 */
const ELM_SOURCE_KEYS = new Set(["annotation", "locator"]);
/** The contained Library MADiE computes over CMS's ELM; it carries CMS's canonical and fqm never reads it. */
const EFFECTIVE_DATA_REQUIREMENTS = "effective-data-requirements";
/** The contained Parameters recording the translator options CMS compiled its main library with. */
const TRANSLATOR_OPTIONS = "options";
const CQL_OPTIONS_EXTENSION = "http://hl7.org/fhir/StructureDefinition/cqf-cqlOptions";
/** What every translation's label and Measure title say, before the CMS measure it was derived from. */
export const DERIVED_LABEL_PREFIX = "WorkWell translation of ";

/**
 * `QICORE_MODEL_INFO.sha256` in `standards/qicore-compile.ts`, repeated rather than imported: that module
 * loads the translator at import time and is build-only, and this one runs in the worker on every router
 * construction. `qicore-compile.test.ts` pins the two equal, so they cannot drift apart silently.
 */
export const QICORE_MODEL_INFO_SHA256 = "75cf34cca8b6ce28f0841201681ff6f2db2235cdcd4ad39bd84c01b8ea76ad33";
export const TRANSLATOR_PACKAGE = "@cqframework/cql";

let installedVersion: string | undefined;

/**
 * The version of the CQL translator installed beside this worker. The package exports neither "." nor
 * "./package.json" (requiring either throws ERR_PACKAGE_PATH_NOT_EXPORTED), so an entry it DOES export is
 * resolved and the directory walked up to the manifest that names the package. Read once per process.
 */
export function installedTranslatorVersion(): string {
  if (installedVersion !== undefined) return installedVersion;
  let dir = dirname(createRequire(import.meta.url).resolve(`${TRANSLATOR_PACKAGE}/cql-to-elm`));
  for (;;) {
    let pkg: { name?: unknown; version?: unknown } | undefined;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    } catch {
      pkg = undefined; // no manifest at this level (or an unreadable one): keep walking up
    }
    // The name is checked because a nested package.json (e.g. one that only sets "type") is not the package's.
    if (pkg?.name === TRANSLATOR_PACKAGE && typeof pkg.version === "string") return (installedVersion = pkg.version);
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json naming ${TRANSLATOR_PACKAGE} above its resolved entry`);
    dir = parent;
  }
}

/** What `derived.build.translator` must say for a translation built with the installed translator. */
export const translatorId = (version: string): string => `${TRANSLATOR_PACKAGE}@${version}`;

interface Resource {
  resourceType?: string;
  [key: string]: unknown;
}
interface Bundle {
  id?: unknown;
  identifier?: unknown;
  entry?: Array<{ resource?: Resource }>;
}
interface LibraryContent {
  contentType?: string;
  data?: string;
}

const resources = (bundle: Bundle): Resource[] => (bundle.entry ?? []).map((e) => e.resource).filter((r): r is Resource => !!r);
const measureOf = (bundle: Bundle): Resource | undefined => resources(bundle).find((r) => r.resourceType === "Measure");
const librariesOf = (bundle: Bundle): Resource[] => resources(bundle).filter((r) => r.resourceType === "Library");

function elmContent(library: Resource): LibraryContent | undefined {
  const content = library["content"];
  return Array.isArray(content) ? (content as LibraryContent[]).find((c) => c?.contentType === "application/elm+json") : undefined;
}

/** The hash a library's ELM is pinned by: SHA-256 of the ELM JSON exactly as the bundle stores it. */
export function libraryElmSha256(library: Resource): string | undefined {
  const data = elmContent(library)?.data;
  return typeof data === "string" && data ? `sha256:${createHash("sha256").update(Buffer.from(data, "base64")).digest("hex")}` : undefined;
}

/** The parts of an ELM library the identity check reads, every one of them possibly absent or malformed. */
interface ElmShape {
  library?: {
    identifier?: { id?: unknown; version?: unknown; system?: unknown };
    includes?: { def?: unknown };
    valueSets?: { def?: unknown };
    codes?: { def?: unknown };
    codeSystems?: { def?: unknown };
  };
}
interface IncludeDef {
  localIdentifier?: unknown;
  path?: unknown;
  version?: unknown;
}
/** A library's ELM decoded ONCE per check: `elm` absent with `unparseable` false means it carries none. */
interface DecodedElm {
  elm?: ElmShape;
  unparseable: boolean;
}
/**
 * What reachability reads of a library's ELM: its identifier and its includes. Kept apart from the decoded
 * ELM so the ~2.4 MB of parsed JSON is garbage the moment its own library has been checked.
 */
interface ElmRefs {
  identifier?: { id?: unknown; version?: unknown; system?: unknown };
  includes: IncludeDef[];
}

function decodeElm(library: Resource): DecodedElm {
  const data = elmContent(library)?.data;
  if (typeof data !== "string" || !data) return { unparseable: false };
  try {
    return { elm: JSON.parse(Buffer.from(data, "base64").toString("utf8")) as ElmShape, unparseable: false };
  } catch {
    return { unparseable: true };
  }
}

function refsOf(elm: ElmShape | undefined): ElmRefs {
  const identifier = elm?.library?.identifier;
  const defs = elm?.library?.includes?.def;
  return {
    identifier: identifier && typeof identifier === "object" ? identifier : undefined,
    includes: Array.isArray(defs) ? defs.filter((d): d is IncludeDef => !!d && typeof d === "object") : [],
  };
}

const DIRECT_REFERENCE_CODE = "http://hl7.org/fhir/StructureDefinition/cqf-directReferenceCode";
/** The entries of a list that are objects; anything else (absent, not a list, a scalar entry) reads as none. */
const recordsIn = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)) : [];
const defsOf = (section: unknown): Array<Record<string, unknown>> =>
  section && typeof section === "object" ? recordsIn((section as { def?: unknown }).def) : [];

/**
 * D10 for one library: what its computed data requirements say it reads, against what its own ELM declares.
 *
 * (a) The value-set URLs it names must EQUAL its ELM's `valueSets.def[].id`, compared as exact strings, as
 * fqm compares them. The URLs are collected exactly as fqm-execution 1.8.5 collects them
 * (`build/execution/ValueSetHelper.js`, `getMissingDependentValuesets`, the branch WorkWell runs: it never
 * sets `useEffectiveDataRequirements`):
 * - every `dataRequirement[].codeFilter[].valueSet` that is set (`:156-169`);
 * - every `relatedArtifact` of type `depends-on` whose `url` (the legacy field) contains "ValueSet", or
 *   failing that whose `resource` does (`:172-184`). fqm reads `url` first, and `resource` only when `url`
 *   does not name a value set.
 * fqm then throws "Missing the following valuesets" for any URL absent from its cache (`:192-200`), and a
 * translation's cache is built from its ELM declarations: a URL only the lists name refuses every
 * evaluation. A URL only the ELM declares is the other half of a stale list — data requirements that no
 * longer describe the logic — and is refused too. Non-string values are skipped (FHIR types them as
 * strings; fqm would throw on one).
 *
 * (b) Every `cqf-directReferenceCode` extension's code must be one its ELM declares in `codes.def`, matched
 * by code and by the system its code-system reference resolves to in its OWN `codeSystems.def`. A code
 * whose code system lives in another library (`codeSystem.libraryName`) does not resolve here, so an
 * extension naming one is refused; none of the committed artifacts writes one.
 *
 * One sentence per violation, naming the library, the URL or code, and the list. A library with no ELM
 * object is one sentence: there is nothing to compare its lists against. Pure; exported so the committed
 * official artifacts, which the router does not hold to D10, can be held to it by a unit test.
 */
export function libraryDataRequirementProblems(library: Readonly<Record<string, unknown>>, elm: unknown): string[] {
  const key = `${String(library["name"])}|${String(library["version"])}`;
  const lib = elm && typeof elm === "object" ? (elm as ElmShape).library : undefined;
  if (!lib || typeof lib !== "object") return [`library ${key} carries no ELM library to check its data requirements against`];
  const problems: string[] = [];

  const declared = new Set(defsOf(lib.valueSets).map((d) => d["id"]).filter((u): u is string => typeof u === "string"));
  const related = new Set<string>();
  for (const ra of recordsIn(library["relatedArtifact"])) {
    if (ra["type"] !== "depends-on") continue;
    const url = ra["url"];
    const resource = ra["resource"];
    if (typeof url === "string" && url.includes("ValueSet")) related.add(url);
    else if (typeof resource === "string" && resource.includes("ValueSet")) related.add(resource);
  }
  const filtered = new Set<string>();
  for (const dr of recordsIn(library["dataRequirement"])) {
    for (const cf of recordsIn(dr["codeFilter"])) {
      const vs = cf["valueSet"];
      if (typeof vs === "string" && vs) filtered.add(vs);
    }
  }
  const unknown = "which its ELM does not declare (valueSets.def); fqm requires every value set these lists name and refuses to evaluate without it";
  for (const url of related) if (!declared.has(url)) problems.push(`library ${key}'s relatedArtifact depends-on names value set ${url}, ${unknown}`);
  for (const url of filtered) if (!declared.has(url)) problems.push(`library ${key}'s dataRequirement code filters name value set ${url}, ${unknown}`);
  for (const url of declared) {
    if (!related.has(url) && !filtered.has(url)) {
      problems.push(`library ${key}'s ELM declares value set ${url}, which neither its relatedArtifact nor its dataRequirement names; its data requirements do not describe its logic`);
    }
  }

  const systems = new Map(defsOf(lib.codeSystems).map((s) => [s["name"], s["id"]]));
  const codeKey = (system: unknown, code: unknown): string => JSON.stringify([system, code]);
  const codes = new Set(
    defsOf(lib.codes).map((c) => {
      const ref = c["codeSystem"] && typeof c["codeSystem"] === "object" ? (c["codeSystem"] as Record<string, unknown>) : {};
      return codeKey(ref["libraryName"] === undefined ? systems.get(ref["name"]) : undefined, c["id"]);
    }),
  );
  for (const ext of recordsIn(library["extension"])) {
    if (ext["url"] !== DIRECT_REFERENCE_CODE) continue;
    const coding = ext["valueCoding"] && typeof ext["valueCoding"] === "object" ? (ext["valueCoding"] as Record<string, unknown>) : {};
    if (typeof coding["code"] !== "string" || typeof coding["system"] !== "string" || !codes.has(codeKey(coding["system"], coding["code"]))) {
      problems.push(
        `library ${key}'s cqf-directReferenceCode extension names code ${String(coding["code"])} of ${String(coding["system"])}, which its ELM does not declare (codes.def, by code and the system its codeSystems.def resolves)`,
      );
    }
  }
  return problems;
}

/** D10 over every library of a bundle, each library's ELM decoded on its own. For tests and checks, not the router. */
export function bundleDataRequirementProblems(bundle: unknown): string[] {
  const problems: string[] = [];
  for (const library of librariesOf((bundle ?? {}) as Bundle)) {
    const { elm, unparseable } = decodeElm(library);
    if (unparseable) problems.push(`library ${String(library["name"])}|${String(library["version"])}'s ELM does not parse`);
    else problems.push(...libraryDataRequirementProblems(library, elm));
  }
  return problems;
}

/** Only the entries of a manifest list that are objects: a hand-edited manifest must come back as sentences. */
function objectsIn<T>(value: unknown): Array<Partial<T>> {
  return Array.isArray(value) ? value.filter((v): v is Partial<T> => !!v && typeof v === "object") : [];
}

export interface DerivedIdentity {
  /** e.g. `urn:workwell:measure:cms137:translation`. */
  url: string;
  /** e.g. `ww-2027.1`. */
  version: string;
  /** Machine name for the Measure and its main library, e.g. `WorkWellCMS137Translation2027`. */
  name: string;
  /** e.g. "WorkWell translation of CMS137v15". */
  title: string;
  /** The CMS measure it is derived from, as display text only, e.g. `CMS137v15`. */
  derivedFrom: string;
  effectivePeriod: { start: string; end: string };
}

/** The library `Measure.library` names (by url, or by `url|version`). */
function mainLibraryOf(bundle: Bundle, measure: Resource): Resource | undefined {
  const mainUrl = ((measure["library"] as string[] | undefined) ?? [])[0];
  return librariesOf(bundle).find((l) => l["url"] === mainUrl || `${l["url"]}|${l["version"]}` === mainUrl);
}

/**
 * Give a compiled bundle the translation's identity (build time only — C3a's builder, and the test
 * fixture). The Measure's id, url, name, title, version, status, publisher and effective period are
 * replaced; its identifiers are removed; a `derived-from` link names the CMS measure. The MAIN library
 * (the one `Measure.library` names) is renamed in its resource id, url, name, version and title and in its
 * ELM, and `Measure.library` is repointed. Group and stratifier ids are left byte-identical: MeasureReport
 * and QRDA strata key on them, and the router requires them to equal CMS's.
 *
 * Removed, not renamed: the Measure's contained `effective-data-requirements` Library and the extension
 * that points at it. MADiE computed it from CMS's ELM, it names CMS's main library by CMS's canonical,
 * and fqm reads it only under an option WorkWell never sets — rewriting it would assert data requirements
 * nobody recomputed.
 *
 * Also removed, because each states something about CMS's publication that is false of the translation:
 * the Bundle's `identifier` (CMS's packaging) — its `id` is renamed instead; the Measure's `usage` (CMS's
 * text, naming the QDM measure the 2026 FHIR draft was derived from) and `date` (CMS's publication date);
 * the main library's `date`, and its contained `options` Parameters with the `cqf-cqlOptions` extension
 * that points at it — those record CMS's compile (translator 3.27.0, annotations and locators on), while
 * the ELM here is WorkWell's compile with both stripped; the translation's own compile is recorded in
 * the manifest's `derived.build`. The builder still checks CMS's recorded options, on CMS's UPSTREAM
 * library, before it compiles (`assertCmsTranslatorOptions`). Kept: `meta.profile` on both resources.
 */
export function rewriteDerivedIdentity<T extends Bundle>(bundle: T, identity: DerivedIdentity): T {
  const copy = JSON.parse(JSON.stringify(bundle)) as T;
  const measure = measureOf(copy);
  if (!measure) throw new Error("bundle has no Measure");
  const mainUrl = ((measure["library"] as string[] | undefined) ?? [])[0];
  const main = mainLibraryOf(copy, measure);
  if (!main) throw new Error(`Measure.library '${mainUrl}' names no library in the bundle`);

  // CMS names its bundle after the measure (`CMS137FHIRSUDTxInitEngagement-bundle`).
  copy.id = `${identity.name}-bundle`;
  delete copy.identifier;

  const libraryUrl = `${DERIVED_LIBRARY_PREFIX}${identity.name}`;
  main["id"] = identity.name;
  main["url"] = libraryUrl;
  main["name"] = identity.name;
  main["version"] = identity.version;
  main["title"] = identity.title;
  // CMS's main library is described by its bare measure name, which is CMS's identity; and WorkWell, not
  // the measure steward, publishes a library WorkWell compiled from edited CQL.
  main["description"] = identity.title;
  main["publisher"] = "WorkWell";
  main["status"] = "draft";
  delete main["identifier"];
  delete main["date"];
  const mainContained = ((main["contained"] as Resource[] | undefined) ?? []).filter(
    (r) => !(r.resourceType === "Parameters" && r["id"] === TRANSLATOR_OPTIONS),
  );
  if (mainContained.length > 0) main["contained"] = mainContained;
  else delete main["contained"];
  const describesOptions = (e: Record<string, unknown>) =>
    e["url"] === CQL_OPTIONS_EXTENSION || (e["valueReference"] as { reference?: unknown } | undefined)?.reference === `#${TRANSLATOR_OPTIONS}`;
  const mainExtensions = ((main["extension"] as Array<Record<string, unknown>> | undefined) ?? []).filter((e) => !describesOptions(e));
  if (mainExtensions.length > 0) main["extension"] = mainExtensions;
  else delete main["extension"];
  const content = elmContent(main);
  if (!content?.data) throw new Error(`main library '${mainUrl}' has no ELM`);
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8")) as { library: { identifier: Record<string, unknown> } };
  elm.library.identifier = { id: identity.name, version: identity.version };
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");

  measure["id"] = identity.name;
  measure["url"] = identity.url;
  measure["name"] = identity.name;
  measure["title"] = identity.title;
  measure["version"] = identity.version;
  measure["status"] = "draft";
  measure["publisher"] = "WorkWell";
  delete measure["date"];
  delete measure["usage"];
  measure["effectivePeriod"] = identity.effectivePeriod;
  measure["identifier"] = [];
  measure["library"] = [libraryUrl];
  const contained = (measure["contained"] as Resource[] | undefined) ?? [];
  const kept = contained.filter((r) => !(r.resourceType === "Library" && r["id"] === EFFECTIVE_DATA_REQUIREMENTS));
  if (kept.length > 0) measure["contained"] = kept;
  else delete measure["contained"];
  const pointsAtRemoved = (e: Record<string, unknown>) =>
    e["valueCanonical"] === `#${EFFECTIVE_DATA_REQUIREMENTS}` ||
    (e["valueReference"] as { reference?: unknown } | undefined)?.reference === `#${EFFECTIVE_DATA_REQUIREMENTS}`;
  const extensions = ((measure["extension"] as Array<Record<string, unknown>> | undefined) ?? []).filter((e) => !pointsAtRemoved(e));
  if (extensions.length > 0) measure["extension"] = extensions;
  else delete measure["extension"];
  const related = ((measure["relatedArtifact"] as Array<Record<string, unknown>> | undefined) ?? []).filter(
    (r) => r["type"] !== "derived-from",
  );
  measure["relatedArtifact"] = [...related, { type: "derived-from", display: identity.derivedFrom }];
  return copy;
}

/** Every string in a resource at any depth, with its path — except `content[].data`, the base64 payload. */
function* stringsIn(node: unknown, path: string): Generator<[string, string]> {
  if (typeof node === "string") {
    yield [path, node];
  } else if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* stringsIn(node[i], `${path}[${i}]`);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "content" && Array.isArray(value)) {
        // The ELM is base64 here, so a text scan of it is meaningless; its keys are checked decoded (below).
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (item && typeof item === "object" && !Array.isArray(item)) {
            for (const [k, v] of Object.entries(item)) if (k !== "data") yield* stringsIn(v, `${path}.content[${i}].${k}`);
          } else {
            yield* stringsIn(item, `${path}.content[${i}]`);
          }
        }
        continue;
      }
      yield* stringsIn(value, `${path}.${key}`);
    }
  }
}

/** The first ELM key carrying CQL source found at any depth, as a path, or undefined. */
function sourceKeyIn(node: unknown, path: string): string | undefined {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = sourceKeyIn(node[i], `${path}[${i}]`);
      if (found) return found;
    }
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (ELM_SOURCE_KEYS.has(key)) return `${path}.${key}`;
      const found = sourceKeyIn(value, `${path}.${key}`);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Everything that makes a translation's identity wrong, as sentences. Empty means it may be routed.
 * Checks the Measure, the manifest, and every library: each one is either listed as unchanged — and then
 * its ELM must be byte-identical to the same-named library in CMS's committed artifact, so "unchanged"
 * is checked against CMS, not against a hash the translation declares about itself — or it carries a
 * WorkWell identity with no CMS host anywhere in it. `base` is CMS's artifact for the measure; it is
 * required, because without it "unchanged" cannot be checked at all.
 *
 * Also checked: the manifest's build record (the pinned model info, the translator installed HERE — a
 * translation compiled by another translator build is rebuilt, not trusted — and well-formed hashes),
 * that no library's ELM carries the keys that hold CMS's CQL text, and that the label every screen shows
 * is the one the Measure carries: `WorkWell translation of <derivedFrom.ecqm>`, equal to the Measure's
 * title, with the Measure's `derived-from` link naming the same CMS measure.
 *
 * And, since a translation may edit a CMS shared library (#779):
 * - reachability, one rule: from `Measure.library[0]`, every ELM include resolves by the engine's own rule
 *   to exactly one library in the bundle, and the set reached is the bundle's set of libraries;
 * - accounting: every library besides the main one is in `unchangedLibraries` or in `changedLibraries`,
 *   never both, and each entry of either names a library the bundle holds;
 * - each `changedLibraries` entry names exactly one library, traces it to a CMS library that CMS's
 *   committed artifact holds with exactly the recorded ELM hash, and that CMS library is gone from the
 *   bundle; its `translationSha256` is a well-formed digest;
 * - a changed library is scanned whole for CMS's identity, as the Measure and main library are;
 * - the Measure's copyright is CMS's, verbatim.
 *
 * And D10 (#782), on the same decode: for every library, the value sets its `relatedArtifact` and
 * `dataRequirement` name, read as fqm reads them, equal its ELM's `valueSets.def`, and its
 * `cqf-directReferenceCode` codes are among its ELM's `codes.def` (`libraryDataRequirementProblems`); and
 * `derived.recomputedDataRequirements`, when present, names only libraries WorkWell compiled. CMS's
 * official artifacts are held to the per-library rule by a committed-artifact test, not here.
 *
 * Every library's ELM is decoded once per check. The result is memoized and frozen; callers copy it,
 * never mutate it.
 */
export function derivedIdentityProblems(
  bundle: Bundle,
  manifest: OfficialManifest,
  base: DerivedBase | null,
  options: DerivedIdentityOptions = {},
): readonly string[] {
  let translator: string;
  try {
    translator = translatorId((options.installedTranslatorVersion ?? installedTranslatorVersion)());
  } catch (err) {
    translator = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
  const key = `${manifest.sha256}|${base?.manifest.sha256 ?? "no-base"}`;
  const hit = memo.get(key);
  if (hit && hit.bundle === bundle && hit.manifest === manifest && hit.base === base && hit.translator === translator) return hit.problems;
  const problems = Object.freeze(computeProblems(bundle, manifest, base, translator));
  memo.set(key, { bundle, manifest, base, translator, problems });
  return problems;
}

export interface DerivedIdentityOptions {
  /** Injectable for tests; defaults to the translator installed beside this worker. */
  installedTranslatorVersion?: () => string;
}

interface MemoEntry {
  bundle: Bundle;
  manifest: OfficialManifest;
  base: DerivedBase | null;
  translator: string;
  problems: readonly string[];
}
type DerivedBase = { bundle: unknown; manifest: Pick<OfficialManifest, "sha256" | "cmsId" | "measureName"> };

/**
 * One verdict per (translation, CMS artifact) pair. The router runs this on every construction — every
 * run and every compliance request — and it decodes and parses ~2.4 MB of ELM each time. Keyed by the two
 * manifest hashes, and served only to the SAME objects it was computed for: the loaders hand out cached,
 * never-mutated artifacts, while a caller holding a different bundle or manifest that merely declares the
 * same hash (a test variant, an edited copy) gets a fresh verdict rather than a stale "valid".
 */
const memo = new Map<string, MemoEntry>();

/** @internal test hook */
export function __clearDerivedIdentityMemo(): void {
  memo.clear();
}

function computeProblems(bundle: Bundle, manifest: OfficialManifest, base: DerivedBase | null, translator: string): string[] {
  const id = manifest.catalogId;
  const problems: string[] = [];
  const derived = manifest.derived;
  if (!derived) return [`${id}: the manifest has no derived block, so it is not a translation`];
  const measure = measureOf(bundle);
  if (!measure) return [`${id}: the translated bundle has no Measure`];

  if (manifest.cmsId !== null) problems.push(`${id}: a translation's manifest must carry cmsId null, not '${manifest.cmsId}'`);
  if (manifest.measureName !== measure["name"]) {
    problems.push(`${id}: the manifest's measureName '${manifest.measureName}' is not the translated Measure's name '${String(measure["name"])}'`);
  }
  // CMS's MADiE deck is CMS's artifact's, pinned under measures/official/; a translation is checked by its
  // oracles, and a `tests` block here would claim a deck under measures/derived/ that does not exist.
  if (manifest.tests !== undefined) problems.push(`${id}: a translation's manifest carries no tests block; its checks are its oracle records`);
  // Read defensively: this runs inside the router, and a hand-edited manifest missing a block must come
  // back as sentences, not as an exception on every request.
  const build: Partial<NonNullable<OfficialManifest["derived"]>["build"]> = derived.build ?? {};
  const packageSha256 = derived.derivedFrom?.packageSha256;
  if (build.modelInfoSha256 !== `sha256:${QICORE_MODEL_INFO_SHA256}`) {
    problems.push(`${id}: the translation was compiled against model info ${build.modelInfoSha256}, not the pinned QICore 6.0.0 (sha256:${QICORE_MODEL_INFO_SHA256})`);
  }
  if (build.translator !== translator) {
    problems.push(`${id}: the translation was compiled by ${build.translator}, but the installed translator is ${translator}; rebuild it`);
  }
  if (!SHA256.test(String(packageSha256))) {
    problems.push(`${id}: derivedFrom.packageSha256 '${packageSha256}' is not a sha256:<64 hex> digest`);
  }
  if (!SHA256.test(String(build.translationSha256))) {
    problems.push(`${id}: build.translationSha256 '${build.translationSha256}' is not a sha256:<64 hex> digest`);
  }
  const url = String(measure["url"] ?? "");
  if (!url.startsWith(DERIVED_CANONICAL_PREFIX)) problems.push(`${id}: the translated Measure's url '${url}' is not a WorkWell canonical`);
  if (manifest.url !== url) problems.push(`${id}: the manifest url '${manifest.url}' does not match the Measure's '${url}'`);
  if (measure["status"] !== "draft") problems.push(`${id}: the translated Measure must be status draft, not '${String(measure["status"])}'`);
  const version = String(measure["version"] ?? "");
  if (!DERIVED_VERSION.test(version)) problems.push(`${id}: the translated Measure's version '${version}' is not a ww- version`);
  if (manifest.version !== version) problems.push(`${id}: the manifest version '${manifest.version}' does not match the Measure's '${version}'`);
  const identifiers = (measure["identifier"] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const identifier of identifiers) {
    const type = ((identifier["type"] as { coding?: Array<{ code?: unknown }> } | undefined)?.coding ?? [])[0]?.code;
    if (typeof type === "string" && FORBIDDEN_IDENTIFIER_TYPES.has(type)) problems.push(`${id}: the translated Measure still carries a CMS '${type}' identifier`);
    if (String(identifier["value"] ?? "").startsWith("urn:uuid:")) problems.push(`${id}: the translated Measure still carries a CMS UUID identifier`);
  }
  for (const field of ["url", "name", "title", "publisher", "library"] as const) {
    if (NAMES_CMS_HOST.test(JSON.stringify(measure[field] ?? ""))) problems.push(`${id}: the translated Measure's ${field} still names ${CMS_HOST}`);
  }
  const related = (measure["relatedArtifact"] as Array<Record<string, unknown>> | undefined) ?? [];
  const derivedFromLinks = related.filter((r) => r["type"] === "derived-from");
  if (derivedFromLinks.length === 0) problems.push(`${id}: the translated Measure has no derived-from link to the CMS measure`);

  // The label is what every screen, API and export names the logic by (`translationLogicFromManifest`),
  // and nothing above reads it: a manifest relabelled "CMS137v15" would put CMS's measure name over
  // WorkWell's counts on every surface — the relabel §4.3 forbids — while the bundle stayed honest. So
  // the label is tied to the three places it must agree with, each of which the builder writes from one
  // identity: its own fixed form, the Measure's title, and the CMS measure the derived-from link names.
  const label = derived.label;
  const ecqm = derived.derivedFrom?.ecqm;
  if (typeof ecqm !== "string" || ecqm.trim() === "") {
    problems.push(`${id}: derivedFrom.ecqm '${String(ecqm)}' does not name the CMS measure the translation is derived from`);
  } else {
    if (label !== `${DERIVED_LABEL_PREFIX}${ecqm}`) {
      problems.push(`${id}: the translation's label '${String(label)}' is not '${DERIVED_LABEL_PREFIX}${ecqm}'; the label is what every screen names the logic by`);
    }
    for (const link of derivedFromLinks) {
      if (link["display"] !== ecqm) {
        problems.push(`${id}: the translated Measure's derived-from link names '${String(link["display"])}', but the manifest says it is derived from '${ecqm}'`);
      }
    }
  }
  if (measure["title"] !== label) {
    problems.push(`${id}: the translation's label '${String(label)}' is not the translated Measure's title '${String(measure["title"])}'`);
  }

  if (!base) problems.push(`${id}: CMS's artifact for this measure is not committed, so its 'unchanged' libraries cannot be checked`);
  else if (derived.base?.manifestSha256 !== base.manifest.sha256) {
    problems.push(`${id}: the translation was built on CMS's artifact ${derived.base?.manifestSha256}, but the committed one is ${base.manifest.sha256}`);
  }
  const cmsMeasure = base ? measureOf(base.bundle as Bundle) : undefined;
  // The copyright is the notice of the measure the translation is derived from (NCQA's, for CMS130), and it
  // travels with logic derived from that measure exactly as CMS published it: neither edited, nor dropped,
  // nor added. Absent on both is equal. It is the one CMS text a translation must keep, so it is checked
  // for equality rather than left to the identity scan, which it passes either way.
  if (cmsMeasure && measure["copyright"] !== cmsMeasure["copyright"]) {
    problems.push(`${id}: the translated Measure's copyright is not CMS's Measure's, verbatim; a translation carries the notice of the measure it is derived from unchanged`);
  }

  // Read defensively, as the build record is: a list that is not a list, or an entry that is not an
  // object, comes back as a sentence or is skipped, never as an exception inside the router.
  if (derived.unchangedLibraries !== undefined && !Array.isArray(derived.unchangedLibraries)) problems.push(`${id}: derived.unchangedLibraries is not a list`);
  if (derived.changedLibraries !== undefined && !Array.isArray(derived.changedLibraries)) problems.push(`${id}: derived.changedLibraries is not a list`);
  const entryKey = (entry: { name?: unknown; version?: unknown }): string => `${String(entry.name)}|${String(entry.version)}`;
  const unchanged = new Map(objectsIn<DerivedManifestBlock["unchangedLibraries"][number]>(derived.unchangedLibraries).map((l) => [entryKey(l), l.elmSha256]));
  const changedEntries = objectsIn<DerivedChangedLibrary>(derived.changedLibraries);
  const libraries = librariesOf(bundle);
  const keyOf = (library: Resource): string => `${String(library["name"])}|${String(library["version"])}`;
  const main = mainLibraryOf(bundle, measure);
  if (!main) problems.push(`${id}: the translated Measure's library '${String(((measure["library"] as unknown[] | undefined) ?? [])[0])}' names no library in the bundle`);
  // Every library that must carry WorkWell's identity: all but the main one (checked as the main library)
  // and those pinned as carried unchanged. A library in neither manifest list is one of these too, so CMS's
  // library left in the bundle unlisted is held to WorkWell's identity — and fails it.
  const changedLibraries = libraries.filter((l) => l !== main && !unchanged.has(keyOf(l)));

  // The named fields above are where a reader LOOKS for identity; CMS's identity also hides in places
  // nobody reads by name (the resource id, a contained Library, a description that is the bare measure
  // name, the Bundle's own id). So the Measure, the main library and every changed library are scanned
  // whole, every string at any depth, and so are the Bundle's own `id` and `identifier`. The one exception
  // is a `depends-on` of the main library or a changed library naming a library carried unchanged: that IS
  // CMS's library, under CMS's canonical, and pointing at it by any other name would be the false claim.
  // (CMS's AdvancedIllnessandFrailty, edited for CMS130, depends on four libraries carried unchanged.)
  //
  // The needles are CMS's host, its canonicals, and its NAMES — the measure name and the short name
  // (`CMS` + the base manifest's cmsId, e.g. `CMS137FHIR`), read from CMS's committed manifest rather than
  // written here, so a second translated measure brings its own. Matched without regard to case.
  const cmsMain = cmsMeasure ? mainLibraryOf(base!.bundle as Bundle, cmsMeasure) : undefined;
  const cmsShortName = typeof base?.manifest.cmsId === "string" && base.manifest.cmsId.length > 0 ? `CMS${base.manifest.cmsId}` : undefined;
  const needles = [CMS_HOST, cmsMeasure?.["url"], cmsMain?.["url"], cmsMeasure?.["id"], cmsShortName, base?.manifest.measureName]
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((n) => n.toLowerCase());
  const unchangedCanonicals = new Set(
    libraries.filter((l) => unchanged.has(keyOf(l))).flatMap((l) => [String(l["url"]), `${String(l["url"])}|${String(l["version"])}`]),
  );
  // Only the Bundle's OWN fields: its entries are the resources scanned (or pinned) one by one.
  const bundleOwn: Resource = { id: bundle.id, identifier: bundle.identifier };
  const scanned: Array<[what: string, resource: Resource | undefined, root: string]> = [
    ["Bundle", bundleOwn, "Bundle"],
    ["Measure", measure, "Measure"],
    ["main library", main, "Library"],
    ...changedLibraries.map((l): [string, Resource, string] => [`changed library ${keyOf(l)}`, l, "Library"]),
  ];
  for (const [what, resource, root] of scanned) {
    if (!resource) continue;
    const dependsOn = new Set<string>();
    if (root === "Library") {
      const related = resource["relatedArtifact"];
      (Array.isArray(related) ? (related as Array<Record<string, unknown> | null>) : []).forEach((r, i) => {
        if (r?.["type"] === "depends-on" && unchangedCanonicals.has(String(r["resource"]))) dependsOn.add(`${root}.relatedArtifact[${i}].resource`);
      });
    }
    const found: string[] = [];
    for (const [path, value] of stringsIn(resource, root)) {
      if (dependsOn.has(path)) continue;
      const lower = value.toLowerCase();
      if (needles.some((n) => lower.includes(n))) found.push(`${path} '${value.length > 80 ? `${value.slice(0, 80)}…` : value}'`);
    }
    if (found.length > 0) {
      problems.push(
        `${id}: the translated ${what} still carries CMS's identity in ${found.length} place(s): ${found.slice(0, 5).join(", ")}${found.length > 5 ? ", …" : ""}`,
      );
    }
  }

  const cmsLibraries = new Map(librariesOf((base?.bundle ?? {}) as Bundle).map((l) => [keyOf(l), libraryElmSha256(l)]));
  const cmsLibraryNames = new Set(librariesOf((base?.bundle ?? {}) as Bundle).map((l) => String(l["name"])));
  // Each library's ELM is decoded here ONCE, and only its identifier and includes outlive this loop (for
  // reachability, below): this runs on every router construction, over ~2.4 MB of ELM.
  const refs = new Map<Resource, ElmRefs>();
  for (const library of libraries) {
    const key = keyOf(library);
    // ELM keeps CMS's CQL text in `annotation` and its positions in `locator`. CMS's own libraries were
    // vendored stripped, so EVERY library — unchanged ones included — must be free of both, or the repo
    // would be committing CMS's CQL inside a WorkWell artifact. `localId` is allowed: it carries no CQL.
    const { elm, unparseable } = decodeElm(library);
    refs.set(library, refsOf(elm));
    const leaked = unparseable ? "(the ELM does not parse)" : elm !== undefined ? sourceKeyIn(elm, "elm") : undefined;
    if (leaked) problems.push(`${id}: library ${key}'s ELM carries ${leaked}; ELM is committed stripped of annotation and locator`);
    // D10, on the ELM already decoded: what the library's lists say it reads is what its ELM declares. A
    // library with no ELM is refused by reachability, and one whose ELM does not parse just above.
    if (elm !== undefined) for (const p of libraryDataRequirementProblems(library, elm)) problems.push(`${id}: ${p}`);
    if (unchanged.has(key)) {
      const pinned = unchanged.get(key);
      const actual = libraryElmSha256(library);
      if (typeof pinned !== "string" || actual !== pinned) problems.push(`${id}: library ${key} is listed as unchanged but its ELM does not match its pin`);
      else if (base && cmsLibraries.get(key) !== actual) {
        problems.push(`${id}: library ${key} keeps CMS's identity but its ELM is not CMS's — a library WorkWell changed must carry WorkWell's identity`);
      }
      continue;
    }
    // A library WorkWell changed carries WorkWell's identity in EVERY field a reader keys on: its url, its
    // name and version, and the identifier inside its ELM. A CMS name is a plain token (`CMS137FHIR`),
    // not a hostname, so it is checked against CMS's own library names rather than for the host alone.
    const libraryName = String(library["name"] ?? "");
    const libraryVersion = String(library["version"] ?? "");
    const libraryUrl = String(library["url"] ?? "");
    if (!libraryUrl.startsWith(DERIVED_LIBRARY_PREFIX)) problems.push(`${id}: changed library ${key} has url '${libraryUrl}', not a WorkWell library canonical`);
    if (cmsLibraryNames.has(libraryName)) problems.push(`${id}: changed library ${key} keeps CMS's library name '${libraryName}'`);
    if (!DERIVED_VERSION.test(libraryVersion)) problems.push(`${id}: changed library ${key} has version '${libraryVersion}', not a ww- version`);
    const elmIdentifier = elm?.library?.identifier;
    if (!elmIdentifier) problems.push(`${id}: changed library ${key} has no ELM identifier to check`);
    else if (elmIdentifier.id !== libraryName || elmIdentifier.version !== libraryVersion) {
      problems.push(`${id}: changed library ${key}'s ELM is identified as '${String(elmIdentifier.id)}|${String(elmIdentifier.version)}', not as the library itself`);
    }
    if (NAMES_CMS_HOST.test(JSON.stringify(elmIdentifier ?? "")) || NAMES_CMS_HOST.test(JSON.stringify([library["url"], library["name"]]))) {
      problems.push(`${id}: changed library ${key} still names ${CMS_HOST}`);
    }
  }

  if (main) problems.push(...reachabilityProblems(id, main, libraries, refs, keyOf));

  // Accounting: every library besides the main one is carried unchanged (pinned to CMS's bytes above) or
  // listed as changed (traced to CMS's library below) — exactly one of the two. The main library is named
  // by the translation's own identity and is in neither list. And neither list may name a library the
  // bundle does not hold: a record of a library that is not there is a record of a different translation.
  const changedByKey = new Map<string, Partial<DerivedChangedLibrary>>();
  for (const entry of changedEntries) {
    const key = entryKey(entry);
    if (changedByKey.has(key)) problems.push(`${id}: changedLibraries lists ${key} more than once`);
    changedByKey.set(key, entry);
  }
  for (const library of libraries) {
    const key = keyOf(library);
    const isUnchanged = unchanged.has(key);
    const isChanged = changedByKey.has(key);
    if (library === main) {
      if (isUnchanged || isChanged) {
        problems.push(`${id}: the main library ${key} is listed in ${isUnchanged ? "unchangedLibraries" : "changedLibraries"}; it carries the translation's own identity and is listed in neither`);
      }
    } else if (isUnchanged && isChanged) {
      problems.push(`${id}: library ${key} is listed both as carried unchanged and as changed; it is one or the other`);
    } else if (!isUnchanged && !isChanged) {
      problems.push(`${id}: library ${key} is neither listed as carried unchanged (unchangedLibraries) nor as changed (changedLibraries); every library besides the main one is accounted for in exactly one`);
    }
  }
  const bundleKeys = new Set(libraries.map(keyOf));
  for (const key of unchanged.keys()) {
    if (!bundleKeys.has(key)) problems.push(`${id}: unchangedLibraries lists ${key}, which is not in the bundle`);
  }

  // Each changed library is traced to the CMS library it was edited from, and that trace is checked
  // against CMS's committed artifact, never against the translation's word for it — as "unchanged" is.
  // CMS's library must also be GONE from the bundle: beside WorkWell's copy it would be a second library
  // answering to the same logic, under CMS's name.
  for (const [key, entry] of changedByKey) {
    const matches = libraries.filter((l) => keyOf(l) === key).length;
    if (matches !== 1) {
      problems.push(`${id}: changedLibraries lists ${key}, which ${matches === 0 ? "is not in the bundle" : `matches ${matches} libraries in the bundle`}; each entry names exactly one`);
    }
    const from = entry.from && typeof entry.from === "object" ? entry.from : undefined;
    if (typeof from?.name !== "string" || typeof from.version !== "string") {
      problems.push(`${id}: changed library ${key} does not name the CMS library it was edited from (from.name and from.version)`);
    } else {
      const fromKey = `${from.name}|${from.version}`;
      if (base) {
        const cmsElm = cmsLibraries.get(fromKey);
        if (!cmsLibraries.has(fromKey)) {
          problems.push(`${id}: changed library ${key} says it was edited from CMS's ${fromKey}, which CMS's committed artifact does not hold`);
        } else if (from.elmSha256 !== cmsElm) {
          problems.push(`${id}: changed library ${key} says it was edited from CMS's ${fromKey} with ELM ${String(from.elmSha256)}, but CMS's committed ELM for it is ${String(cmsElm)}`);
        }
      }
      if (bundleKeys.has(fromKey)) {
        problems.push(`${id}: CMS's ${fromKey}, which changed library ${key} replaces, is still in the bundle; a translation carries WorkWell's copy instead of CMS's library, never beside it`);
      }
    }
    if (!SHA256.test(String(entry.translationSha256))) {
      problems.push(`${id}: changed library ${key}'s translationSha256 '${String(entry.translationSha256)}' is not a sha256:<64 hex> digest`);
    }
  }

  // D10, the manifest's record of it: `recomputedDataRequirements` may name only a library WorkWell
  // compiled — the main library or one listed as changed. CMS's lists on a library carried unchanged are
  // CMS's, pinned with its ELM; a record of recomputing them, or a library the bundle lacks, is false.
  // Read defensively, as the other lists are.
  const recomputed: unknown = derived.recomputedDataRequirements;
  if (recomputed !== undefined) {
    if (!Array.isArray(recomputed)) {
      problems.push(`${id}: derived.recomputedDataRequirements is not a list`);
    } else {
      const compiled = new Set(libraries.filter((l) => l === main || changedByKey.has(keyOf(l))).map((l) => l["name"]));
      const seen = new Set<string>();
      recomputed.forEach((name: unknown, i) => {
        if (typeof name !== "string") {
          problems.push(`${id}: derived.recomputedDataRequirements[${i}] is not a library name`);
          return;
        }
        if (seen.has(name)) problems.push(`${id}: derived.recomputedDataRequirements lists '${name}' more than once`);
        seen.add(name);
        if (!compiled.has(name)) {
          problems.push(`${id}: derived.recomputedDataRequirements names '${name}', which is not a library WorkWell compiled in this bundle (the main library or a changedLibraries entry)`);
        }
      });
    }
  }
  return problems;
}

/**
 * Which libraries the translation runs, decided by the engine's own rule — so a bundle that passes here is
 * one fqm resolves the same way, and one that fails would have failed (or run the wrong library) in fqm.
 *
 * The rule, confirmed in the installed packages:
 * - fqm (`fqm-execution` 1.8.5, `build/helpers/MeasureBundleHelpers.js:463`, `extractLibrariesFromBundle`)
 *   rewrites every `includes.def[].path` to what follows its last `/` before execution —
 *   `includedLibraryName`. CMS's committed ELM writes `https://madie.cms.gov/FHIRHelpers`, so without this
 *   cut every unchanged CMS library would read as unresolvable and the live CMS137 translation would be
 *   refused, taking every evaluating route on the Maui sandbox down with it.
 * - cql-execution (3.3.2, `lib/runtime/repository.js:10-27`, `Repository.resolve`) then takes the FIRST
 *   library, in bundle order, whose ELM `identifier.id` equals that name (or whose `system/id` does —
 *   never true of a path with no `/`), and whose `identifier.version` equals the include's version when
 *   the include gives one (`if (version)`: any version when it does not). An include nothing answers to is
 *   left undefined (`lib/elm/library.js:69`) and fails only when the logic first reads through it.
 * - The Measure's own logic is resolved the same way: fqm reads the main library's ELM identifier and asks
 *   the repository for it (`build/execution/Execution.js:49`).
 *
 * The resource's `name`/`url` play no part; only the ELM identifier does. So "exactly one" is checked
 * here where the engine would silently take the first, and a `urn:workwell:…` include path — no `/` to
 * cut at — is unresolvable, as it would be in fqm.
 */
function reachabilityProblems(
  id: string,
  main: Resource,
  libraries: Resource[],
  refs: Map<Resource, ElmRefs>,
  keyOf: (library: Resource) => string,
): string[] {
  const problems: string[] = [];
  const identifierOf = (library: Resource) => refs.get(library)?.identifier;
  const resolve = (name: string, version: unknown): Resource[] =>
    libraries.filter((l) => {
      const identifier = identifierOf(l);
      return identifier?.id === name && (!version || identifier.version === version);
    });
  const named = (found: Resource[]) => found.map(keyOf).join(", ");

  const root = identifierOf(main);
  if (typeof root?.id === "string") {
    const roots = resolve(root.id, root.version);
    if (roots.length > 1) {
      problems.push(
        `${id}: the main library ${keyOf(main)}'s ELM is identified as '${root.id}|${String(root.version)}', and so ${roots.length - 1 === 1 ? "is another library" : `are ${roots.length - 1} other libraries`} in the bundle (${named(roots.filter((l) => l !== main))}); the engine runs the first of them in bundle order as the Measure's logic`,
      );
    }
  }

  const reached = new Set<Resource>([main]);
  const queue: Resource[] = [main];
  for (let library = queue.shift(); library; library = queue.shift()) {
    for (const include of refs.get(library)?.includes ?? []) {
      const local = String(include.localIdentifier);
      if (typeof include.path !== "string" || include.path === "") {
        problems.push(`${id}: library ${keyOf(library)} includes ${local} with no path, which the engine cannot resolve`);
        continue;
      }
      const name = includedLibraryName(include.path);
      const as = `${local} as '${include.path}'${include.version ? ` version ${String(include.version)}` : " (any version)"}`;
      const found = resolve(name, include.version);
      if (found.length === 0) {
        problems.push(
          `${id}: library ${keyOf(library)} includes ${as}, which resolves to no library in the bundle; the engine matches '${name}' (the path after its last '/') and the version against each library's ELM identifier`,
        );
        continue;
      }
      if (found.length > 1) {
        problems.push(`${id}: library ${keyOf(library)} includes ${as}, which ${found.length} libraries in the bundle answer to (${named(found)}); the engine takes the first in bundle order`);
      }
      // Walk on into what the engine would actually run: the first match.
      if (!reached.has(found[0]!)) {
        reached.add(found[0]!);
        queue.push(found[0]!);
      }
    }
  }
  for (const library of libraries) {
    if (!reached.has(library)) {
      problems.push(`${id}: library ${keyOf(library)} is in the bundle, but nothing the main library includes, directly or through another library, resolves to it; a library the engine never runs is not part of the translation`);
    }
  }
  return problems;
}
