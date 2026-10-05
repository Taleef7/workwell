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
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OfficialManifest } from "../wiring/official-artifacts.ts";

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
  return ((library["content"] as LibraryContent[] | undefined) ?? []).find((c) => c.contentType === "application/elm+json");
}

/** The hash a library's ELM is pinned by: SHA-256 of the ELM JSON exactly as the bundle stores it. */
export function libraryElmSha256(library: Resource): string | undefined {
  const data = elmContent(library)?.data;
  return data ? `sha256:${createHash("sha256").update(Buffer.from(data, "base64")).digest("hex")}` : undefined;
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
 * title, with the Measure's `derived-from` link naming the same CMS measure. The result is memoized and
 * frozen; callers copy it, never mutate it.
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
  const unchanged = new Map((derived.unchangedLibraries ?? []).map((l) => [`${l.name}|${l.version}`, l.elmSha256]));

  // The named fields above are where a reader LOOKS for identity; CMS's identity also hides in places
  // nobody reads by name (the resource id, a contained Library, a description that is the bare measure
  // name, the Bundle's own id). So the Measure and the main library are scanned whole, every string at any
  // depth, and so are the Bundle's own `id` and `identifier`. The one exception is a main-library
  // `depends-on` naming a library carried unchanged: that IS CMS's library, under CMS's canonical, and
  // pointing at it by any other name would be the false claim.
  //
  // The needles are CMS's host, its canonicals, and its NAMES — the measure name and the short name
  // (`CMS` + the base manifest's cmsId, e.g. `CMS137FHIR`), read from CMS's committed manifest rather than
  // written here, so a second translated measure brings its own. Matched without regard to case.
  const cmsMeasure = base ? measureOf(base.bundle as Bundle) : undefined;
  const cmsMain = cmsMeasure ? mainLibraryOf(base!.bundle as Bundle, cmsMeasure) : undefined;
  const cmsShortName = typeof base?.manifest.cmsId === "string" && base.manifest.cmsId.length > 0 ? `CMS${base.manifest.cmsId}` : undefined;
  const needles = [CMS_HOST, cmsMeasure?.["url"], cmsMain?.["url"], cmsMeasure?.["id"], cmsShortName, base?.manifest.measureName]
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((n) => n.toLowerCase());
  const unchangedCanonicals = new Set(
    librariesOf(bundle)
      .filter((l) => unchanged.has(`${String(l["name"])}|${String(l["version"])}`))
      .flatMap((l) => [String(l["url"]), `${String(l["url"])}|${String(l["version"])}`]),
  );
  const main = mainLibraryOf(bundle, measure);
  if (!main) problems.push(`${id}: the translated Measure's library '${String(((measure["library"] as unknown[] | undefined) ?? [])[0])}' names no library in the bundle`);
  // Only the Bundle's OWN fields: its entries are the resources scanned (or pinned) one by one.
  const bundleOwn: Resource = { id: bundle.id, identifier: bundle.identifier };
  const scanned = [["Bundle", bundleOwn, "Bundle"], ["Measure", measure, "Measure"], ["main library", main, "Library"]] as const;
  for (const [what, resource, root] of scanned) {
    if (!resource) continue;
    const dependsOn = new Set<string>();
    if (resource === main) {
      ((main["relatedArtifact"] as Array<Record<string, unknown>> | undefined) ?? []).forEach((r, i) => {
        if (r["type"] === "depends-on" && unchangedCanonicals.has(String(r["resource"]))) dependsOn.add(`${root}.relatedArtifact[${i}].resource`);
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

  const cmsLibraries = new Map(librariesOf((base?.bundle ?? {}) as Bundle).map((l) => [`${String(l["name"])}|${String(l["version"])}`, libraryElmSha256(l)]));
  const cmsLibraryNames = new Set(librariesOf((base?.bundle ?? {}) as Bundle).map((l) => String(l["name"])));
  for (const library of librariesOf(bundle)) {
    const key = `${String(library["name"])}|${String(library["version"])}`;
    // ELM keeps CMS's CQL text in `annotation` and its positions in `locator`. CMS's own libraries were
    // vendored stripped, so EVERY library — unchanged ones included — must be free of both, or the repo
    // would be committing CMS's CQL inside a WorkWell artifact. `localId` is allowed: it carries no CQL.
    const elmData = elmContent(library)?.data;
    let elm: { library?: { identifier?: { id?: unknown; version?: unknown } } } | undefined;
    if (elmData) {
      let leaked: string | undefined;
      try {
        elm = JSON.parse(Buffer.from(elmData, "base64").toString("utf8")) as typeof elm;
        leaked = sourceKeyIn(elm, "elm");
      } catch {
        leaked = "(the ELM does not parse)";
      }
      if (leaked) problems.push(`${id}: library ${key}'s ELM carries ${leaked}; ELM is committed stripped of annotation and locator`);
    }
    const pinned = unchanged.get(key);
    if (pinned !== undefined) {
      const actual = libraryElmSha256(library);
      if (actual !== pinned) problems.push(`${id}: library ${key} is listed as unchanged but its ELM does not match its pin`);
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
  return problems;
}
