/**
 * A CMS shared library WorkWell EDITED for a translation (#779): the WorkWell identity it carries, and the
 * rewrite that gives a compiled copy of it that identity and repoints the measure's main library at it.
 *
 * Build time only (`build:derived` and test fixtures). The library is compiled under CMS's own name, so its
 * includes, type-checking and known warnings resolve exactly as CMS's do; only afterwards is it renamed,
 * the same order `rewriteDerivedIdentity` uses for the main library. An unedited library is never renamed:
 * that would present CMS's untouched work as WorkWell's.
 */
import { createHash } from "node:crypto";
import { DERIVED_LIBRARY_PREFIX, type DerivedIdentity } from "./derived-identity.ts";

interface Resource {
  resourceType?: string;
  [key: string]: unknown;
}
interface Bundle {
  entry?: Array<{ resource?: Resource }>;
}
interface ElmLibrary {
  library: {
    identifier: { id?: unknown; version?: unknown; system?: unknown };
    includes?: { def?: Array<{ localIdentifier?: unknown; path?: unknown; version?: unknown }> };
  } & Record<string, unknown>;
}

const TRANSLATOR_OPTIONS = "options";
const CQL_OPTIONS_EXTENSION = "http://hl7.org/fhir/StructureDefinition/cqf-cqlOptions";
const ELM = "application/elm+json";

/**
 * The library an ELM `includes.def[].path` names, by the rule the engine resolves it with: fqm keeps only
 * what follows the path's last `/` (CMS's committed ELM writes `https://madie.cms.gov/FHIRHelpers`), and
 * cql-execution then matches that against each library's `identifier.id` with the include's version. So a
 * `urn:workwell:…` path — no `/` — would never resolve, which is why a changed library is included by its
 * bare name.
 */
export function includedLibraryName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export interface ChangedLibraryIdentity {
  /** e.g. `WorkWellAdvancedIllnessandFrailtyTranslation2027`. */
  name: string;
  /** The translation's own `ww-YYYY.N`. */
  version: string;
  /** `urn:workwell:library:<name>`. */
  url: string;
  /** e.g. "WorkWell translation of CMS's AdvancedIllnessandFrailty 1.27.000, for CMS130v15". */
  title: string;
}

/** The identity a CMS library `cmsName` `cmsVersion` takes once WorkWell has edited it for `translation`. */
export function changedLibraryIdentity(cmsName: string, cmsVersion: string, translation: DerivedIdentity): ChangedLibraryIdentity {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(cmsName)) throw new Error(`library name '${cmsName}' is not a plain CQL identifier`);
  const year = translation.effectivePeriod.start.slice(0, 4);
  const name = `WorkWell${cmsName}Translation${year}`;
  // A FHIR id is at most 64 characters, and the resource id is the name.
  if (name.length > 64) throw new Error(`the changed library's name '${name}' is longer than a FHIR id may be (64)`);
  return {
    name,
    version: translation.version,
    url: `${DERIVED_LIBRARY_PREFIX}${name}`,
    title: `WorkWell translation of CMS's ${cmsName} ${cmsVersion}, for ${translation.derivedFrom}`,
  };
}

const resources = (bundle: Bundle): Resource[] => (bundle.entry ?? []).map((e) => e.resource).filter((r): r is Resource => !!r);
const libraries = (bundle: Bundle): Resource[] => resources(bundle).filter((r) => r.resourceType === "Library");

function elmOf(library: Resource): ElmLibrary {
  const data = ((library["content"] as Array<{ contentType?: string; data?: string }> | undefined) ?? []).find((c) => c.contentType === ELM)?.data;
  if (!data) throw new Error(`library ${String(library["name"])} ${String(library["version"])} has no ELM`);
  return JSON.parse(Buffer.from(data, "base64").toString("utf8")) as ElmLibrary;
}

function setElm(library: Resource, elm: unknown): void {
  library["content"] = [{ contentType: ELM, data: Buffer.from(JSON.stringify(elm), "utf8").toString("base64") }];
}

/** The SHA-256 of a CQL text as the manifest records it (LF line endings). */
export const cqlSha256 = (cql: string): string => `sha256:${createHash("sha256").update(cql.replace(/\r\n/g, "\n")).digest("hex")}`;

/**
 * Put WorkWell's compile of an edited CMS library into a translation's bundle under `identity`, and repoint
 * the main library at it. `compiledElm` is the edited library compiled UNDER CMS'S NAME (already stripped of
 * `annotation`/`locator`); it must be that library's, or the bundle would carry the wrong logic under a
 * name that checks out.
 *
 * Refused: no library or more than one named `from`; an ELM compiled as another library; and an edited
 * library that any library OTHER than the main one includes — rewiring that library's ELM would break the
 * pin it is carried under, and the change would have to cascade (no translation needs that yet).
 */
export function rewriteChangedLibrary<T extends Bundle>(
  bundle: T,
  from: { name: string; version: string },
  compiledElm: ElmLibrary,
  identity: ChangedLibraryIdentity,
): T {
  const copy = JSON.parse(JSON.stringify(bundle)) as T;
  const measure = resources(copy).find((r) => r.resourceType === "Measure");
  if (!measure) throw new Error("bundle has no Measure");
  const mainRef = ((measure["library"] as string[] | undefined) ?? [])[0];
  const all = libraries(copy);
  const main = all.find((l) => l["url"] === mainRef || `${String(l["url"])}|${String(l["version"])}` === mainRef);
  if (!main) throw new Error(`Measure.library '${String(mainRef)}' names no library in the bundle`);

  const matches = all.filter((l) => l["name"] === from.name && l["version"] === from.version);
  if (matches.length !== 1) throw new Error(`the bundle holds ${matches.length} libraries named ${from.name} ${from.version}, not exactly one`);
  const target = matches[0]!;
  if (target === main) throw new Error(`${from.name} is the main library; it is renamed by rewriteDerivedIdentity, not as a changed library`);
  const compiledId = compiledElm.library.identifier;
  if (compiledId.id !== from.name || compiledId.version !== from.version) {
    throw new Error(`the compiled ELM is ${String(compiledId.id)}|${String(compiledId.version)}, not ${from.name}|${from.version}`);
  }

  const includers = all.filter((l) =>
    (elmOf(l).library.includes?.def ?? []).some((d) => typeof d.path === "string" && includedLibraryName(d.path) === from.name && d.version === from.version),
  );
  const foreign = includers.filter((l) => l !== main).map((l) => `${String(l["name"])} ${String(l["version"])}`);
  if (foreign.length > 0) {
    throw new Error(`${from.name} ${from.version} is also included by ${foreign.join(", ")}; only an edit of a library the main library alone includes is supported`);
  }
  if (includers.length === 0) throw new Error(`no library includes ${from.name} ${from.version}`);

  const cmsUrl = String(target["url"] ?? "");
  target["id"] = identity.name;
  target["url"] = identity.url;
  target["name"] = identity.name;
  target["version"] = identity.version;
  target["title"] = identity.title;
  target["description"] = identity.title;
  target["publisher"] = "WorkWell";
  target["status"] = "draft";
  delete target["identifier"];
  delete target["date"];
  const contained = ((target["contained"] as Resource[] | undefined) ?? []).filter((r) => !(r.resourceType === "Parameters" && r["id"] === TRANSLATOR_OPTIONS));
  if (contained.length > 0) target["contained"] = contained;
  else delete target["contained"];
  const describesOptions = (e: Record<string, unknown>) =>
    e["url"] === CQL_OPTIONS_EXTENSION || (e["valueReference"] as { reference?: unknown } | undefined)?.reference === `#${TRANSLATOR_OPTIONS}`;
  const extensions = ((target["extension"] as Array<Record<string, unknown>> | undefined) ?? []).filter((e) => !describesOptions(e));
  if (extensions.length > 0) target["extension"] = extensions;
  else delete target["extension"];
  const elm = JSON.parse(JSON.stringify(compiledElm)) as ElmLibrary;
  elm.library.identifier = { id: identity.name, version: identity.version };
  setElm(target, elm);

  // The main library: its ELM include by the bare name (see `includedLibraryName`), and its depends-on by
  // WorkWell's canonical. The include's local identifier is untouched, so no expression reference moves.
  const mainElm = elmOf(main);
  for (const def of mainElm.library.includes?.def ?? []) {
    if (typeof def.path === "string" && includedLibraryName(def.path) === from.name && def.version === from.version) {
      def.path = identity.name;
      def.version = identity.version;
    }
  }
  setElm(main, mainElm);
  const dependsOn = `${identity.url}|${identity.version}`;
  main["relatedArtifact"] = ((main["relatedArtifact"] as Array<Record<string, unknown>> | undefined) ?? []).map((r) =>
    r["type"] === "depends-on" && (r["resource"] === cmsUrl || r["resource"] === `${cmsUrl}|${from.version}`) ? { ...r, resource: dependsOn } : r,
  );
  return copy;
}
