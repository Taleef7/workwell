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
import type { OfficialManifest } from "../wiring/official-artifacts.ts";

export const DERIVED_CANONICAL_PREFIX = "urn:workwell:measure:";
export const DERIVED_LIBRARY_PREFIX = "urn:workwell:library:";
/** `ww-<year>.<n>`: never confusable with CMS's `1.0.000` or the QDM measure's `15.0.000`. */
export const DERIVED_VERSION = /^ww-\d{4}\.\d+$/;
const FORBIDDEN_IDENTIFIER_TYPES = new Set(["short-name", "version-specific", "version-independent", "publisher"]);
const CMS_HOST = "madie.cms.gov";

interface Resource {
  resourceType?: string;
  [key: string]: unknown;
}
interface Bundle {
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

/**
 * Give a compiled bundle the translation's identity (build time only — C3a's builder, and the test
 * fixture). The Measure's url, name, title, version, status, publisher and effective period are
 * replaced; its identifiers are removed; a `derived-from` link names the CMS measure. The MAIN library
 * (the one `Measure.library` names) is renamed in both its resource and its ELM, and `Measure.library`
 * is repointed. Group and stratifier ids are left byte-identical: MeasureReport and QRDA strata key on
 * them, and the router requires them to equal CMS's.
 */
export function rewriteDerivedIdentity<T extends Bundle>(bundle: T, identity: DerivedIdentity): T {
  const copy = JSON.parse(JSON.stringify(bundle)) as T;
  const measure = measureOf(copy);
  if (!measure) throw new Error("bundle has no Measure");
  const mainUrl = ((measure["library"] as string[] | undefined) ?? [])[0];
  const main = librariesOf(copy).find((l) => l["url"] === mainUrl || `${l["url"]}|${l["version"]}` === mainUrl);
  if (!main) throw new Error(`Measure.library '${mainUrl}' names no library in the bundle`);

  const libraryUrl = `${DERIVED_LIBRARY_PREFIX}${identity.name}`;
  main["url"] = libraryUrl;
  main["name"] = identity.name;
  main["version"] = identity.version;
  main["title"] = identity.title;
  delete main["identifier"];
  const content = elmContent(main);
  if (!content?.data) throw new Error(`main library '${mainUrl}' has no ELM`);
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8")) as { library: { identifier: Record<string, unknown> } };
  elm.library.identifier = { id: identity.name, version: identity.version };
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");

  measure["url"] = identity.url;
  measure["name"] = identity.name;
  measure["title"] = identity.title;
  measure["version"] = identity.version;
  measure["status"] = "draft";
  measure["publisher"] = "WorkWell";
  measure["effectivePeriod"] = identity.effectivePeriod;
  measure["identifier"] = [];
  measure["library"] = [libraryUrl];
  const related = ((measure["relatedArtifact"] as Array<Record<string, unknown>> | undefined) ?? []).filter(
    (r) => r["type"] !== "derived-from",
  );
  measure["relatedArtifact"] = [...related, { type: "derived-from", display: identity.derivedFrom }];
  return copy;
}

/**
 * Everything that makes a translation's identity wrong, as sentences. Empty means it may be routed.
 * Checks the Measure, the manifest, and every library: each one is either listed as unchanged — and then
 * its ELM must be byte-identical to the same-named library in CMS's committed artifact, so "unchanged"
 * is checked against CMS, not against a hash the translation declares about itself — or it carries a
 * WorkWell identity with no CMS host anywhere in it. `base` is CMS's artifact for the measure; it is
 * required, because without it "unchanged" cannot be checked at all.
 */
export function derivedIdentityProblems(
  bundle: Bundle,
  manifest: OfficialManifest,
  base: { bundle: unknown; manifest: Pick<OfficialManifest, "sha256"> } | null,
): string[] {
  const id = manifest.catalogId;
  const problems: string[] = [];
  const derived = manifest.derived;
  if (!derived) return [`${id}: the manifest has no derived block, so it is not a translation`];
  const measure = measureOf(bundle);
  if (!measure) return [`${id}: the translated bundle has no Measure`];

  if (manifest.cmsId !== null) problems.push(`${id}: a translation's manifest must carry cmsId null, not '${manifest.cmsId}'`);
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
    if (JSON.stringify(measure[field] ?? "").includes(CMS_HOST)) problems.push(`${id}: the translated Measure's ${field} still names ${CMS_HOST}`);
  }
  const related = (measure["relatedArtifact"] as Array<Record<string, unknown>> | undefined) ?? [];
  if (!related.some((r) => r["type"] === "derived-from")) problems.push(`${id}: the translated Measure has no derived-from link to the CMS measure`);

  if (!base) problems.push(`${id}: CMS's artifact for this measure is not committed, so its 'unchanged' libraries cannot be checked`);
  else if (derived.base.manifestSha256 !== base.manifest.sha256) {
    problems.push(`${id}: the translation was built on CMS's artifact ${derived.base.manifestSha256}, but the committed one is ${base.manifest.sha256}`);
  }
  const cmsLibraries = new Map(librariesOf((base?.bundle ?? {}) as Bundle).map((l) => [`${String(l["name"])}|${String(l["version"])}`, libraryElmSha256(l)]));
  const unchanged = new Map(derived.unchangedLibraries.map((l) => [`${l.name}|${l.version}`, l.elmSha256]));
  for (const library of librariesOf(bundle)) {
    const key = `${String(library["name"])}|${String(library["version"])}`;
    const pinned = unchanged.get(key);
    if (pinned !== undefined) {
      const actual = libraryElmSha256(library);
      if (actual !== pinned) problems.push(`${id}: library ${key} is listed as unchanged but its ELM does not match its pin`);
      else if (base && cmsLibraries.get(key) !== actual) {
        problems.push(`${id}: library ${key} keeps CMS's identity but its ELM is not CMS's — a library WorkWell changed must carry WorkWell's identity`);
      }
      continue;
    }
    const libraryUrl = String(library["url"] ?? "");
    if (!libraryUrl.startsWith(DERIVED_LIBRARY_PREFIX)) problems.push(`${id}: changed library ${key} has url '${libraryUrl}', not a WorkWell library canonical`);
    const data = elmContent(library)?.data;
    const elmIdentifier = data ? (JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { library?: { identifier?: unknown } }).library?.identifier : undefined;
    if (JSON.stringify(elmIdentifier ?? "").includes(CMS_HOST) || JSON.stringify([library["url"], library["name"]]).includes(CMS_HOST)) {
      problems.push(`${id}: changed library ${key} still names ${CMS_HOST}`);
    }
  }
  return problems;
}
