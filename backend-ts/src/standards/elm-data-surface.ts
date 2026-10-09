/**
 * What an ELM library READS from a record — its data surface — as one value two compiles can be compared
 * by (#779). Build time only (`build:derived`).
 *
 * A translation carries CMS's computed data requirements as they are: the Measure's `dataRequirement`
 * entries and the main library's `depends-on` value sets were computed by MADiE from CMS's ELM, and nothing
 * recomputes them. That is honest only while WorkWell's edits change nothing a retrieve asks for. So the
 * builder refuses an edited library — and the main library, which is always WorkWell's compile — unless its
 * surface here equals the surface of CMS's committed ELM for the same library: the same value sets, codes
 * and code systems declared, and the same retrieves, counted with multiplicity. An edit that only changes
 * how retrieved data is compared (`starts during` → `overlaps`) leaves the surface as it was; an edit that
 * retrieves another value set, or one more resource type, does not.
 *
 * The projection keeps what decides WHICH data is fetched — `dataType`, `templateId`, `codeProperty`,
 * `codeComparator`, `codes`, and `codeFilter` (ELM's other way of saying `codes`; empty in every retrieve
 * either translator writes today, and kept so a code test moved there is not invisible) — and resolves a
 * local `ValueSetRef` / `CodeRef` to what it names (a value set's canonical, a code and its system's
 * canonical), so the comparison is about the value set, not about how a declaration is spelled. Inside
 * `codes`, the keys that carry positions, CQL text or static typing (`localId`, `locator`, `annotation`,
 * `resultTypeName`, `resultTypeSpecifier`) are dropped: they do not change what is fetched.
 *
 * Calibrated 2026-10-09 against an UNEDITED recompile (`@cqframework/cql`, the pinned QI-Core model info)
 * of every library of cms130 and cms137, CMS's AdvancedIllnessandFrailty and both main libraries
 * included: every surface equals the one from CMS's committed ELM. In fact, once our compile is stripped
 * like the committed ELM (`stripElmDebugKeys`; it also writes `annotation: []` on every node), the two
 * translators write byte-equal Retrieve nodes for every one of those libraries, so nothing had to be
 * dropped to make the calibration pass; the dropped keys are the ones a later translator could write
 * differently without changing a single fetch. The calibration needs CMS's CQL, so it is not a committed
 * test; `elm-data-surface.test.ts` holds the shapes.
 */

export interface ElmDataSurface {
  /** `valueSets.def[].id`, sorted: the value-set canonicals the library declares. */
  valueSets: string[];
  /** `codes.def[]` as `<code>|<its code system's canonical>`, sorted. */
  codes: string[];
  /** `codeSystems.def[].id`, sorted. */
  codeSystems: string[];
  /**
   * Every Retrieve node at any depth, projected and serialized with sorted keys, then sorted: a multiset,
   * so a retrieve the translation adds or drops is a difference even when an equal one remains.
   */
  retrieves: string[];
}

type Node = Record<string, unknown>;
interface Def {
  name?: unknown;
  id?: unknown;
  codeSystem?: { name?: unknown; libraryName?: unknown };
}

/** Keys that never decide which data is fetched: positions, CQL text and static typing. */
const INCIDENTAL = new Set(["localId", "locator", "annotation", "resultTypeName", "resultTypeSpecifier"]);

const isNode = (value: unknown): value is Node => !!value && typeof value === "object" && !Array.isArray(value);

/** JSON with every object's keys sorted and the incidental keys dropped, at every depth. */
function canonical(value: unknown): string {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!isNode(node)) return node;
    const out: Node = {};
    for (const key of Object.keys(node).sort()) if (!INCIDENTAL.has(key)) out[key] = clean(node[key]);
    return out;
  };
  return JSON.stringify(clean(value));
}

/**
 * The surface of one compiled library. `elm` is the ELM document (`{ library: … }`), as compiled or as the
 * committed artifact stores it. A local reference to a definition the library does not declare is refused:
 * the translator never writes one, so it means the input is not a compiled library.
 */
export function elmDataSurface(elm: unknown): ElmDataSurface {
  const library = isNode(elm) && isNode(elm["library"]) ? elm["library"] : undefined;
  if (!library) throw new Error("not an ELM document: it has no library");
  const label = (() => {
    const identifier = isNode(library["identifier"]) ? library["identifier"] : {};
    return `${String(identifier["id"])} ${String(identifier["version"])}`;
  })();
  const defs = (section: string): Def[] => {
    const block = library[section];
    return isNode(block) && Array.isArray(block["def"]) ? (block["def"] as Def[]) : [];
  };
  const valueSetDefs = defs("valueSets");
  const codeDefs = defs("codes");
  const codeSystemDefs = defs("codeSystems");
  const valueSetIds = new Map(valueSetDefs.map((d) => [String(d.name), String(d.id)]));
  const codeSystemIds = new Map(codeSystemDefs.map((d) => [String(d.name), String(d.id)]));
  const codesByName = new Map(codeDefs.map((d) => [String(d.name), d]));

  const systemOf = (code: Def): string => {
    const ref = code.codeSystem;
    if (!ref) return "(no system)";
    if (ref.libraryName !== undefined) return `${String(ref.libraryName)}:${String(ref.name)}`;
    const id = codeSystemIds.get(String(ref.name));
    if (id === undefined) throw new Error(`ELM library ${label}: code '${String(code.name)}' names code system '${String(ref.name)}', which it does not declare`);
    return id;
  };

  // A ref into another library is recorded as that library's local alias and the name, which both compiles
  // of the same CQL write alike; a local ref is replaced by what it names.
  const resolveCodes = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolveCodes);
    if (!isNode(node)) return node;
    if (node["type"] === "ValueSetRef") {
      if (node["libraryName"] !== undefined) return { valueSetRef: `${String(node["libraryName"])}:${String(node["name"])}` };
      const id = valueSetIds.get(String(node["name"]));
      if (id === undefined) throw new Error(`ELM library ${label}: a retrieve names value set '${String(node["name"])}', which it does not declare`);
      return { valueSet: id };
    }
    if (node["type"] === "CodeRef") {
      if (node["libraryName"] !== undefined) return { codeRef: `${String(node["libraryName"])}:${String(node["name"])}` };
      const code = codesByName.get(String(node["name"]));
      if (!code) throw new Error(`ELM library ${label}: a retrieve names code '${String(node["name"])}', which it does not declare`);
      return { code: String(code.id), system: systemOf(code) };
    }
    const out: Node = {};
    for (const key of Object.keys(node)) out[key] = resolveCodes(node[key]);
    return out;
  };

  const retrieves: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isNode(node)) return;
    if (node["type"] === "Retrieve") {
      retrieves.push(
        canonical({
          dataType: node["dataType"] ?? null,
          templateId: node["templateId"] ?? null,
          codeProperty: node["codeProperty"] ?? null,
          codeComparator: node["codeComparator"] ?? null,
          codes: node["codes"] === undefined ? null : resolveCodes(node["codes"]),
          // Absent and empty mean the same (no filter), so a translator that omits the empty array agrees.
          codeFilter: resolveCodes(node["codeFilter"] ?? []),
        }),
      );
    }
    // Into the retrieve too: a nested retrieve (in its `codes`, `context` or a filter) is fetched as well.
    for (const key of Object.keys(node)) if (key !== "annotation") walk(node[key]);
  };
  walk(library["statements"]);

  return {
    valueSets: valueSetDefs.map((d) => String(d.id)).sort(),
    codes: codeDefs.map((d) => `${String(d.id)}|${systemOf(d)}`).sort(),
    codeSystems: codeSystemDefs.map((d) => String(d.id)).sort(),
    retrieves: retrieves.sort(),
  };
}

/**
 * Where two surfaces differ, one sentence per part, each naming up to three entries on each side (value-set
 * and code-system canonicals, codes, projected retrieves: identifiers, never CQL text). Multiset
 * difference, so a duplicated retrieve on one side is reported. Empty means equal.
 */
export function dataSurfaceDifferences(cms: ElmDataSurface, ours: ElmDataSurface): string[] {
  const out: string[] = [];
  const minus = (a: readonly string[], b: readonly string[]): string[] => {
    const left = new Map<string, number>();
    for (const item of b) left.set(item, (left.get(item) ?? 0) + 1);
    return a.filter((item) => {
      const n = left.get(item) ?? 0;
      if (n === 0) return true;
      left.set(item, n - 1);
      return false;
    });
  };
  const show = (items: string[]) =>
    `${items.length} (${items.slice(0, 3).map((i) => (i.length > 200 ? `${i.slice(0, 200)}…` : i)).join("; ")}${items.length > 3 ? "; …" : ""})`;
  for (const part of ["valueSets", "codes", "codeSystems", "retrieves"] as const) {
    const onlyCms = minus(cms[part], ours[part]);
    const onlyOurs = minus(ours[part], cms[part]);
    if (onlyCms.length === 0 && onlyOurs.length === 0) continue;
    const sides = [onlyCms.length > 0 ? `only in CMS's ${show(onlyCms)}` : "", onlyOurs.length > 0 ? `only in the translation's ${show(onlyOurs)}` : ""];
    out.push(`${part}: ${sides.filter(Boolean).join(", ")}`);
  }
  return out;
}
