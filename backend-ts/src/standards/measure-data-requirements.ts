/**
 * What FHIR data a measure's logic reads, computed from its ELM (#776).
 *
 * The walk starts where the Measure says the score comes from — each group's population criteria and
 * stratifiers — and, separately, from its supplemental data elements, which are reported beside the score
 * and never change it. From each named expression it follows every expression and function reference,
 * across included libraries, and collects each `Retrieve`'s resource type and profile. A definition no
 * criterion reaches is never read, however many retrieves it holds.
 *
 * Why not the bundle's own declarations: each Library's `dataRequirement` lists everything the LIBRARY
 * might read, so a union of them overcounts (QICoreCommon names DeviceRequest whether or not a measure uses
 * it), and the pruned `effective-data-requirements` Library MADiE computes is absent from a WorkWell
 * translation by design (`derived-identity.ts`). For every CMS artifact the two agree, which the test proves.
 *
 * Library references resolve by NAME (the last segment of an include path or canonical): CMS artifacts
 * include `https://madie.cms.gov/FHIRHelpers`, a translation includes plain `FHIRHelpers`. Function
 * overloads match by name, so a measure can read as needing slightly more than it does, never less.
 */

type Json = Record<string, unknown>;

/** One resource type a measure reads, and what for. */
export interface TypeRequirement {
  /** The FHIR resource type, e.g. `Observation`. */
  readonly type: string;
  /** Reached from a population or stratifier criterion, so it can change the score. */
  readonly forScore: boolean;
  /** Reached from a supplemental data element (reported beside the score, never part of it). */
  readonly forSde: boolean;
  /** The profiles its retrieves name (`Retrieve.templateId`), sorted. */
  readonly profiles: readonly string[];
  /** Some retrieve of this type names no profile. */
  readonly untemplated: boolean;
}

interface ElmDef {
  name?: string;
  type?: string;
  expression?: unknown;
  operand?: unknown;
}

interface ElmLibrary {
  name: string;
  /** include alias → library name */
  includes: Map<string, string>;
  /** definition name → every definition of that name (functions overload) */
  defs: Map<string, ElmDef[]>;
}

const nameOf = (path: string): string => path.split("|")[0]!.split(/[/:]/).pop()!;

function decodeElm(library: Json): Json | null {
  const content = (library["content"] as Array<{ contentType?: string; data?: string }> | undefined) ?? [];
  const elm = content.find((c) => c.contentType === "application/elm+json" && typeof c.data === "string");
  return elm ? (JSON.parse(Buffer.from(elm.data!, "base64").toString("utf8")) as Json) : null;
}

function librariesOf(bundle: unknown): Map<string, ElmLibrary> {
  const libraries = new Map<string, ElmLibrary>();
  for (const entry of ((bundle as { entry?: Array<{ resource?: Json }> }).entry ?? [])) {
    const resource = entry.resource;
    if (resource?.["resourceType"] !== "Library") continue;
    const elm = decodeElm(resource);
    if (!elm) continue;
    const library = elm["library"] as Json;
    const name = String((library["identifier"] as Json | undefined)?.["id"] ?? resource["name"]);
    const includes = new Map<string, string>();
    for (const include of (((library["includes"] as Json | undefined)?.["def"] as Json[] | undefined) ?? [])) {
      includes.set(String(include["localIdentifier"]), nameOf(String(include["path"])));
    }
    const defs = new Map<string, ElmDef[]>();
    for (const def of (((library["statements"] as Json | undefined)?.["def"] as ElmDef[] | undefined) ?? [])) {
      if (!def.name) continue;
      defs.set(def.name, [...(defs.get(def.name) ?? []), def]);
    }
    libraries.set(name, { name, includes, defs });
  }
  return libraries;
}

function measureOf(bundle: unknown): Json {
  const measure = ((bundle as { entry?: Array<{ resource?: Json }> }).entry ?? [])
    .map((entry) => entry.resource)
    .find((resource) => resource?.["resourceType"] === "Measure");
  if (!measure) throw new Error("the bundle holds no Measure");
  return measure;
}

const criteriaOf = (items: unknown): string[] =>
  ((items as Array<{ criteria?: { expression?: unknown } }> | undefined) ?? [])
    .map((item) => item.criteria?.expression)
    .filter((expression): expression is string => typeof expression === "string");

/**
 * Every resource type the measure's score and supplemental data read, sorted by type. Throws on a bundle
 * whose main library or a referenced definition it cannot find: a walk that silently stopped would report
 * a measure as needing less than it does.
 */
export function measureDataRequirements(bundle: unknown): TypeRequirement[] {
  const libraries = librariesOf(bundle);
  const measure = measureOf(bundle);
  const mainName = nameOf(String((measure["library"] as string[] | undefined)?.[0] ?? ""));
  const main = libraries.get(mainName);
  if (!main) throw new Error(`the Measure's library ${mainName} is not in the bundle`);

  // A multi-component stratifier keeps its criteria on each component instead of on itself.
  const stratifiers = (group: Json) => (group["stratifier"] as Json[] | undefined) ?? [];
  const scoreRoots = (measure["group"] as Json[] | undefined ?? []).flatMap((group) => [
    ...criteriaOf(group["population"]),
    ...criteriaOf(stratifiers(group)),
    ...stratifiers(group).flatMap((stratifier) => criteriaOf(stratifier["component"])),
  ]);
  const sdeRoots = criteriaOf(measure["supplementalData"]);

  const found = new Map<string, { forScore: boolean; forSde: boolean; profiles: Set<string>; untemplated: boolean }>();
  const walk = (roots: string[], use: "forScore" | "forSde") => {
    const seen = new Set<string>();
    const visitDef = (library: ElmLibrary, name: string) => {
      const key = `${library.name}.${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const defs = library.defs.get(name);
      if (!defs) throw new Error(`${library.name} has no definition ${name}`);
      for (const def of defs) visitNode(library, def.expression);
    };
    const resolve = (library: ElmLibrary, alias: unknown): ElmLibrary => {
      if (alias === undefined) return library;
      const target = library.includes.get(String(alias));
      const resolved = target ? libraries.get(target) : undefined;
      if (!resolved) throw new Error(`${library.name} references ${String(alias)}, which is not in the bundle`);
      return resolved;
    };
    const visitNode = (library: ElmLibrary, node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visitNode(library, item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Json;
      if (record["type"] === "Retrieve" && typeof record["dataType"] === "string") {
        const type = (record["dataType"] as string).replace(/^\{[^}]*\}/, "");
        const entry = found.get(type) ?? { forScore: false, forSde: false, profiles: new Set<string>(), untemplated: false };
        entry[use] = true;
        if (typeof record["templateId"] === "string") entry.profiles.add(record["templateId"] as string);
        else entry.untemplated = true;
        found.set(type, entry);
      }
      if ((record["type"] === "ExpressionRef" || record["type"] === "FunctionRef") && typeof record["name"] === "string") {
        visitDef(resolve(library, record["libraryName"]), record["name"] as string);
      }
      for (const value of Object.values(record)) visitNode(library, value);
    };
    for (const root of roots) visitDef(main, root);
  };
  walk(scoreRoots, "forScore");
  walk(sdeRoots, "forSde");

  return [...found.entries()]
    .map(([type, entry]) => ({
      type,
      forScore: entry.forScore,
      forSde: entry.forSde,
      profiles: [...entry.profiles].sort(),
      untemplated: entry.untemplated,
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}
