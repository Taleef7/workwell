/**
 * The computed data requirements of a library WorkWell compiled whose READS changed (#782): CMS's lists,
 * edited in place to describe our ELM. Build time only (`assembleTranslationBundle`).
 *
 * A translation carries each library's `dataRequirement`, `relatedArtifact` and `cqf-directReferenceCode`
 * lists as MADiE computed them from CMS's ELM. fqm acts on two of them: it collects every value-set URL
 * the `dataRequirement` code filters and the `depends-on` entries name, and refuses to evaluate while any
 * is missing from its cache — which, for a translation, is built from the ELM's declarations. So a main
 * library whose edit drops a value set (CMS125v15 drops `…198.12.1071`) but still lists it fails every
 * evaluation. When a library's `elmDataSurface` differs from CMS's committed ELM for the same library,
 * its lists are therefore edited to match ours; when it does not, they are returned untouched, byte for
 * byte (so CMS130 and CMS137, whose edits move no retrieve, rebuild exactly as they were).
 *
 * EDITED, not rebuilt. fqm's `Calculator.calculateDataRequirements` was rejected: it is transitive (it
 * would put AdvancedIllnessandFrailty's and Hospice's value sets on the main library), drops
 * `mustSupport`, and re-emits the stale `relatedArtifact` union. What MADiE writes was read off the
 * committed artifacts instead, and only that is reproduced:
 *
 * - `relatedArtifact`: the `depends-on` entries for code systems then value sets are exactly
 *   `codeSystems.def` then `valueSets.def`, in declaration order, displayed "Code system <name>" and
 *   "Value set <name>", after the Library entries. Held for every library of all nine committed official
 *   artifacts (`derived-data-requirements.test.ts`), so the rewrite is `rewriteDeclaredLists` from the ELM.
 * - `cqf-directReferenceCode`: one extension per `codes.def` entry whose code system the library declares
 *   itself, in declaration order, `valueCoding` `{ system, code, display: <the code's CQL NAME> }` — the
 *   name, not the `display` string (CQMCommon's "Retrospective Diagnosis" is declared with display
 *   "Retrospetive Diagnosis", and MADiE writes the name), never deduplicated (QICoreCommon lists a repeated
 *   code twice), and a code whose system lives in another library is left out (CumulativeMedicationDuration
 *   declares 48 codes and MADiE lists the 26 on its own systems). Held on the same nine artifacts.
 * - `dataRequirement`: one entry per retrieve, not deduplicated (`{ type, profile: [templateId],
 *   mustSupport, codeFilter: [{ path, valueSet }] }`), plus entries MADiE derives from other uses (the
 *   second `Patient` entry with `mustSupport: ["extension"]`, and a shared library's entries for the types
 *   its functions take) that no single retrieve accounts for. So this list is NOT regenerated: the entry
 *   of each retrieve only CMS's ELM has is removed, matched by type, profile and code filter (a retrieve
 *   with no entry to remove is refused — the list is not what this file believes it is), and an entry in
 *   MADiE's shape is appended for each retrieve only ours has, in our ELM's order. Every other entry,
 *   with its `mustSupport` and position, is CMS's.
 *
 * The appended entry's `mustSupport` is the retrieve's code path, then the paths the enclosing queries
 * read off the alias the retrieve's rows are bound to, innermost query first, in document order,
 * deduplicated: a `Property` scoped to the alias (or sourced from an `AliasRef` to it), and for a chain
 * such as `Alias.status.value` every prefix (`status`, `status.value`). The rows reach an alias through
 * a function's operands (a fluent `isProcedurePerformed`) and out of a single-source query with no
 * `return`, but NOT through a `union` or `As`, across an `ExpressionRef` into another define, or into a
 * function's body: `isProcedurePerformed` reads `status`, which the entry does not list. That is MADiE's
 * rule as far as the committed artifacts show it — CMS125's `Procedure` entries are `["code",
 * "performed"]`, and its unspecified-laterality conditions, read under a `union`, list only `code` though
 * the query reads `bodySite` off them. Calibrated 2026-10-10: deriving an entry for EVERY retrieve of the
 * cms125, cms130, cms137, cms165 and cms951 main libraries reproduces 92 of their 93 MADiE entries
 * exactly (the miss: one CMS165 blood-pressure entry where MADiE also lists `encounter.class` and
 * `encounter.class.code`, which no `Property` on the alias reads; its source is not traced); the four main
 * libraries with a code retrieve are refused before they reach the rule, as below. So the appended entry
 * is MADiE's shape, not a guarantee of MADiE's output; nothing executes on `mustSupport` (fqm reads only
 * the code filters).
 *
 * Refused, with a sentence, until a translation needs them: a changed retrieve whose codes are a value set
 * in another library or a code (a direct-reference-code retrieve's entry carries `code`, not `valueSet`,
 * and its exact shape is not calibrated here); a changed retrieve with an ELM `codeFilter`, a comparator
 * other than `in`, or no `templateId`; a versioned code system or value set declaration, which no
 * committed artifact has. Pure and deterministic; the input resource is not modified.
 */
import { dataSurfaceDifferences, elmDataSurface } from "./elm-data-surface.ts";

type Node = Record<string, unknown>;
export interface LibraryResource {
  resourceType?: string;
  [key: string]: unknown;
}

const DIRECT_REFERENCE_CODE = "http://hl7.org/fhir/StructureDefinition/cqf-directReferenceCode";
const VALUE_SET_DISPLAY = "Value set ";
const CODE_SYSTEM_DISPLAY = "Code system ";
const FHIR_TYPE = /^\{http:\/\/hl7\.org\/fhir\}([A-Za-z]+)$/;

const isNode = (value: unknown): value is Node => !!value && typeof value === "object" && !Array.isArray(value);
const nodesIn = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : []);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Where MADiE puts each list in a Library, by the keys that follow it: a list this file creates on a
 * library that had none goes where MADiE would have written it, so the bundle's bytes read like MADiE's.
 */
const FOLLOWING: Record<string, string[]> = {
  extension: ["url", "identifier", "version", "name", "title", "status", "experimental", "type", "date", "publisher", "description", "relatedArtifact", "parameter", "dataRequirement", "content"],
  relatedArtifact: ["parameter", "dataRequirement", "content"],
  dataRequirement: ["content"],
};

/** Set `key` on `resource`, in place when it exists, else before the first key MADiE writes after it. */
function setList(resource: LibraryResource, key: string, value: Node[]): void {
  if (value.length === 0) {
    delete resource[key];
    return;
  }
  if (key in resource) {
    resource[key] = value;
    return;
  }
  const before = (FOLLOWING[key] ?? []).find((k) => k in resource);
  const entries = Object.entries(resource);
  const at = before === undefined ? entries.length : entries.findIndex(([k]) => k === before);
  for (const [k] of entries) delete resource[k];
  for (const [k, v] of [...entries.slice(0, at), [key, value] as [string, unknown], ...entries.slice(at)]) resource[k] = v;
}

function libraryOf(elm: unknown, which: string): Node {
  const library = isNode(elm) && isNode(elm["library"]) ? elm["library"] : undefined;
  if (!library) throw new Error(`${which} is not an ELM document: it has no library`);
  return library;
}
const defsOf = (library: Node, section: string): Node[] => (isNode(library[section]) ? nodesIn((library[section] as Node)["def"]) : []);
const labelOf = (library: Node): string => {
  const identifier = isNode(library["identifier"]) ? library["identifier"] : {};
  return `${String(identifier["id"])} ${String(identifier["version"])}`;
};

/** The `depends-on` entries MADiE writes for an ELM's code systems and value sets, in that order. */
function declaredDependsOn(library: Node): Node[] {
  const entry = (prefix: string, kind: string) => (def: Node): Node => {
    if (def["version"] !== undefined) {
      throw new Error(`ELM library ${labelOf(library)} declares ${kind} '${String(def["name"])}' with a version, and how MADiE lists a versioned one is not known`);
    }
    return { type: "depends-on", display: `${prefix}${String(def["name"])}`, resource: String(def["id"]) };
  };
  return [...defsOf(library, "codeSystems").map(entry(CODE_SYSTEM_DISPLAY, "code system")), ...defsOf(library, "valueSets").map(entry(VALUE_SET_DISPLAY, "value set"))];
}

/** The `cqf-directReferenceCode` extensions MADiE writes for an ELM's codes (see the file comment). */
function directReferenceCodes(library: Node): Node[] {
  const systems = new Map(defsOf(library, "codeSystems").map((d) => [String(d["name"]), d]));
  const out: Node[] = [];
  for (const code of defsOf(library, "codes")) {
    const ref = isNode(code["codeSystem"]) ? code["codeSystem"] : undefined;
    if (!ref) throw new Error(`ELM library ${labelOf(library)}: code '${String(code["name"])}' names no code system`);
    if (ref["libraryName"] !== undefined) continue;
    const system = systems.get(String(ref["name"]));
    if (!system) throw new Error(`ELM library ${labelOf(library)}: code '${String(code["name"])}' names code system '${String(ref["name"])}', which it does not declare`);
    if (system["version"] !== undefined) {
      throw new Error(`ELM library ${labelOf(library)} declares code system '${String(system["name"])}' with a version, and how MADiE lists a versioned one is not known`);
    }
    out.push({ url: DIRECT_REFERENCE_CODE, valueCoding: { system: String(system["id"]), code: String(code["id"]), display: String(code["name"]) } });
  }
  return out;
}

/** A `depends-on` entry for a code system or value set, as MADiE labels them or as fqm would read one. */
function isDeclaredDependsOn(entry: Node): boolean {
  if (entry["type"] !== "depends-on") return false;
  const display = entry["display"];
  if (typeof display === "string" && (display.startsWith(VALUE_SET_DISPLAY) || display.startsWith(CODE_SYSTEM_DISPLAY))) return true;
  // fqm reads `url`, then `resource`, for "ValueSet": an entry it would read as one is one, whatever its display.
  return [entry["url"], entry["resource"]].some((v) => typeof v === "string" && v.includes("ValueSet"));
}

/**
 * `library` with its code-system and value-set `depends-on` entries and its `cqf-directReferenceCode`
 * extensions rewritten from `elm`'s declarations. The rewritten entries take the place of the first one
 * they replace (or, when there was none, `depends-on` entries go last and extensions first, where MADiE
 * puts them); every other entry keeps its place. A list left empty is removed. Exported for the
 * calibration test: on every committed official library, this returns the library unchanged.
 */
export function rewriteDeclaredLists<T extends LibraryResource>(library: T, elm: unknown): T {
  const lib = libraryOf(elm, `the ELM of ${String(library["name"])}`);
  const out = clone(library) as LibraryResource;
  const splice = (key: string, isOld: (entry: Node) => boolean, fresh: Node[], appendWhenNew: boolean) => {
    const list = nodesIn(out[key]);
    const at = list.findIndex(isOld);
    const kept = list.filter((entry) => !isOld(entry));
    const index = at >= 0 ? list.slice(0, at).filter((entry) => !isOld(entry)).length : appendWhenNew ? kept.length : 0;
    setList(out, key, [...kept.slice(0, index), ...fresh, ...kept.slice(index)]);
  };
  splice("relatedArtifact", isDeclaredDependsOn, declaredDependsOn(lib), true);
  splice("extension", (e) => e["url"] === DIRECT_REFERENCE_CODE, directReferenceCodes(lib), false);
  return out as T;
}

/** One Retrieve node of a library, with the aliases its rows are bound to, innermost first. */
interface RetrieveSite {
  node: Node;
  scopes: Array<{ alias: string; query: Node }>;
}

/**
 * Every Retrieve node under `statements`, in document order (the order `elmDataSurface` walks), each with
 * the query aliases its rows flow into: a query source's alias, when the source expression is the
 * retrieve or reaches it only through function operands, extended by the enclosing ones while the query
 * hands its source's rows on unchanged (one source, no `return`, no aggregate); a relationship's alias
 * (`with`/`without`), whose rows go nowhere further. A retrieve under any other operator (`union`, `As`,
 * `exists`), or in a `where`, `let`, `sort`, `return` or `such that`, has no alias.
 */
function retrieveSites(library: Node): RetrieveSite[] {
  const sites: RetrieveSite[] = [];
  const walk = (node: unknown, scopes: RetrieveSite["scopes"]): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, scopes);
      return;
    }
    if (!isNode(node)) return;
    if (node["type"] === "Retrieve") sites.push({ node, scopes });
    if (node["type"] === "Query") {
      const sources = nodesIn(node["source"]);
      const passesOn = sources.length === 1 && node["return"] === undefined && node["aggregate"] === undefined;
      for (const source of sources) walk(source["expression"], [{ alias: String(source["alias"]), query: node }, ...(passesOn ? scopes : [])]);
      for (const relationship of nodesIn(node["relationship"])) {
        walk(relationship["expression"], [{ alias: String(relationship["alias"]), query: node }]);
        walk(relationship["suchThat"], []);
      }
      for (const key of Object.keys(node)) if (key !== "source" && key !== "relationship" && key !== "annotation") walk(node[key], []);
      return;
    }
    // Rows reach an alias through a function's operands (a fluent `isProcedurePerformed`, `verified`) and
    // through nothing else: MADiE lists only the code path for a retrieve under a `union` (CMS125's
    // unspecified-laterality conditions, CMS951's encounters), so this does too.
    for (const key of Object.keys(node)) if (key !== "annotation") walk(node[key], node["type"] === "FunctionRef" ? scopes : []);
  };
  walk(library["statements"], []);
  return sites;
}

/** The paths `query` reads off `alias`, in document order. */
function pathsReadOff(query: Node, alias: string): string[] {
  const paths: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isNode(node)) return;
    if (node["type"] === "Property" && typeof node["path"] === "string") {
      // A chain `Alias.status.value` is Property(value, Property(status, scope Alias)): every prefix is read.
      const chain: string[] = [];
      let at: Node | undefined = node;
      let rooted = false;
      while (at && at["type"] === "Property" && typeof at["path"] === "string") {
        chain.unshift(at["path"]);
        const source: Node | undefined = isNode(at["source"]) ? at["source"] : undefined;
        if (at["scope"] === alias || (source?.["type"] === "AliasRef" && source["name"] === alias)) {
          rooted = true;
          break;
        }
        at = source;
      }
      if (rooted) for (let i = 1; i <= chain.length; i++) if (!paths.includes(chain.slice(0, i).join("."))) paths.push(chain.slice(0, i).join("."));
    }
    for (const key of Object.keys(node)) if (key !== "annotation") walk(node[key]);
  };
  walk(query);
  return paths;
}

/** One retrieve's projection, exactly as `elmDataSurface` projects it (refs resolved against `library`). */
function projectionOf(library: Node, retrieve: Node): string {
  const single = {
    library: {
      identifier: library["identifier"],
      valueSets: library["valueSets"],
      codes: library["codes"],
      codeSystems: library["codeSystems"],
      statements: { def: [{ expression: retrieve }] },
    },
  };
  const { retrieves } = elmDataSurface(single);
  if (retrieves.length !== 1) throw new Error(`ELM library ${labelOf(library)} has a retrieve nested inside another retrieve; its data requirement is not one entry`);
  return retrieves[0]!;
}

interface Projection {
  dataType: unknown;
  templateId: unknown;
  codeProperty: unknown;
  codeComparator: unknown;
  codes: unknown;
  codeFilter: unknown;
}

/** What a changed retrieve's `dataRequirement` entry is keyed by, or a refusal. */
function entryKey(projection: string, side: string): { type: string; profile: string; codePath?: string; valueSet?: string } {
  const p = JSON.parse(projection) as Projection;
  const what = `a retrieve only ${side} has (${projection.length > 300 ? `${projection.slice(0, 300)}…` : projection})`;
  const type = typeof p.dataType === "string" ? FHIR_TYPE.exec(p.dataType)?.[1] : undefined;
  if (!type) throw new Error(`${what} is not of a FHIR type, so it has no dataRequirement entry in MADiE's shape`);
  if (typeof p.templateId !== "string") throw new Error(`${what} names no profile (templateId)`);
  if (!Array.isArray(p.codeFilter) || p.codeFilter.length > 0) throw new Error(`${what} filters by an ELM codeFilter, which is not supported until a translation needs it`);
  if (p.codes === null) {
    if (p.codeComparator !== null || p.codeProperty !== null) throw new Error(`${what} names a code path or comparator without codes`);
    return { type, profile: p.templateId };
  }
  if (isNode(p.codes) && Object.keys(p.codes).length === 1 && typeof p.codes["valueSet"] === "string") {
    if (p.codeComparator !== "in") throw new Error(`${what} compares its value set by '${String(p.codeComparator)}', not 'in'`);
    if (typeof p.codeProperty !== "string") throw new Error(`${what} names no code path`);
    return { type, profile: p.templateId, codePath: p.codeProperty, valueSet: p.codes["valueSet"] };
  }
  if (JSON.stringify(p.codes).includes('"valueSetRef"')) {
    throw new Error(`${what} filters by a value set declared in another library, which is not supported until a translation needs it (MADiE's entry would name it, but this library's relatedArtifact cannot)`);
  }
  throw new Error(`${what} filters by a code, not a value set, which is not supported until a translation needs it`);
}

/** Does MADiE's `entry` describe the retrieve keyed `key`? `mustSupport` is not compared: it is MADiE's. */
function describes(entry: Node, key: ReturnType<typeof entryKey>): boolean {
  if (entry["type"] !== key.type) return false;
  const profile = entry["profile"];
  if (!Array.isArray(profile) || profile.length !== 1 || profile[0] !== key.profile) return false;
  const filters = entry["codeFilter"];
  if (key.valueSet === undefined) return filters === undefined || (Array.isArray(filters) && filters.length === 0);
  if (!Array.isArray(filters) || filters.length !== 1 || !isNode(filters[0])) return false;
  const filter = filters[0];
  return Object.keys(filter).length === 2 && filter["path"] === key.codePath && filter["valueSet"] === key.valueSet;
}

/** The `dataRequirement` entry, in MADiE's shape, for one retrieve WorkWell's ELM has and CMS's does not. */
function entryFor(site: RetrieveSite, key: ReturnType<typeof entryKey>): Node {
  const mustSupport: string[] = [];
  const add = (path: string) => {
    if (!mustSupport.includes(path)) mustSupport.push(path);
  };
  if (key.codePath) add(key.codePath);
  for (const { alias, query } of site.scopes) for (const path of pathsReadOff(query, alias)) add(path);
  return {
    type: key.type,
    profile: [key.profile],
    ...(mustSupport.length > 0 ? { mustSupport } : {}),
    ...(key.valueSet !== undefined ? { codeFilter: [{ path: key.codePath, valueSet: key.valueSet }] } : {}),
  };
}

/** `a` minus `b`, as multisets; the result keeps `a`'s order. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const item of b) left.set(item, (left.get(item) ?? 0) + 1);
  return a.filter((item) => {
    const n = left.get(item) ?? 0;
    if (n === 0) return true;
    left.set(item, n - 1);
    return false;
  });
}

/**
 * `library` (CMS's resource, carried into a translation) with its computed data requirements edited to
 * describe `oursElm`, WorkWell's compile of it, where that reads other data than `cmsElm`, CMS's committed
 * ELM for the same library. Equal surfaces return the library unchanged. See the file comment for the
 * three lists and what is refused.
 */
export function recomputeDataRequirements<T extends LibraryResource>(library: T, cmsElm: unknown, oursElm: unknown): T {
  const name = `${String(library["name"])} ${String(library["version"])}`;
  if (dataSurfaceDifferences(elmDataSurface(cmsElm), elmDataSurface(oursElm)).length === 0) return clone(library);
  const cms = libraryOf(cmsElm, `CMS's ELM for ${name}`);
  const ours = libraryOf(oursElm, `WorkWell's ELM for ${name}`);

  const cmsProjections = retrieveSites(cms).map((site) => projectionOf(cms, site.node));
  const ourSites = retrieveSites(ours).map((site) => ({ site, projection: projectionOf(ours, site.node) }));
  // The walk here must find exactly the retrieves `elmDataSurface` finds, or the edit would describe a
  // library other than the one compared.
  const check = (projections: string[], elm: unknown, whose: string) => {
    if (JSON.stringify([...projections].sort()) !== JSON.stringify(elmDataSurface(elm).retrieves)) {
      throw new Error(`the retrieves found in ${whose} ELM for ${name} are not the ones its data surface counts`);
    }
  };
  check(cmsProjections, cmsElm, "CMS's");
  check(ourSites.map((s) => s.projection), oursElm, "WorkWell's");

  const onlyCms = minus(cmsProjections, ourSites.map((s) => s.projection));
  const onlyOurs = minus(ourSites.map((s) => s.projection), cmsProjections);
  const out = rewriteDeclaredLists(library, oursElm) as LibraryResource;
  const entries = nodesIn(out["dataRequirement"]);
  if (Array.isArray(out["dataRequirement"]) && entries.length !== (out["dataRequirement"] as unknown[]).length) {
    throw new Error(`${name}'s dataRequirement holds an entry that is not an object`);
  }
  for (const projection of onlyCms) {
    const key = entryKey(projection, "CMS's ELM");
    const at = entries.findIndex((entry) => describes(entry, key));
    if (at < 0) {
      throw new Error(
        `${name}: CMS's ELM retrieves ${key.type} (${key.profile}${key.valueSet ? `, value set ${key.valueSet}` : ""}), which WorkWell's does not, ` +
          "but no dataRequirement entry describes that retrieve, so there is no entry to remove; the list is not MADiE's one entry per retrieve",
      );
    }
    entries.splice(at, 1);
  }
  // Appended in OUR ELM's order, consuming the multiset: two equal new retrieves are two entries.
  const pending = [...onlyOurs];
  for (const { site, projection } of ourSites) {
    const at = pending.indexOf(projection);
    if (at < 0) continue;
    pending.splice(at, 1);
    entries.push(entryFor(site, entryKey(projection, "WorkWell's ELM")));
  }
  setList(out, "dataRequirement", entries);
  return out as T;
}
