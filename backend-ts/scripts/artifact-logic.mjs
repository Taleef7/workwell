/**
 * The LOGIC of a measure artifact, hashed apart from its metadata (#848).
 *
 * A vendored bundle's `sha256` moves with any byte: a profile claim, a narrative, a description. The
 * exports give a run CMS's identity only while the artifact that scored it is still the vendored one, so a
 * re-vendor that changed nothing a result depends on would otherwise end that identity for every older
 * run. `logicSha256` hashes only what decides a result:
 *
 * - each Library's url and version, and its ELM JSON (the `application/elm+json` content, decoded);
 * - the Measure's url, version, scoring and libraries, and its groups whole: ids, extensions (scoring,
 *   population basis), populations (codes, criteria) and stratifiers.
 *
 * Terminology is pinned on its own (`terminology.sha256`). Keys are sorted at every depth and Libraries
 * ordered by url|version, so neither JSON key order nor entry order can move the hash.
 *
 * Plain `.mjs` with node built-ins only: `vendor-official-measure.mjs` imports it on the deploy path, where
 * nothing is installed or built.
 */
import { createHash } from "node:crypto";

const ELM_JSON = "application/elm+json";

/** JSON with object keys sorted at every depth: the same value always serializes to the same bytes. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function libraryLogic(library) {
  const elm = (library.content ?? []).filter((c) => c?.contentType === ELM_JSON);
  if (elm.length === 0) {
    throw new Error(`Library ${library.url ?? library.id ?? "?"} has no ELM JSON, so it has no logic to hash`);
  }
  return {
    url: library.url ?? null,
    version: library.version ?? null,
    elm: elm.map((c) => JSON.parse(Buffer.from(String(c.data ?? ""), "base64").toString("utf8"))),
  };
}

function measureLogic(measure) {
  return {
    url: measure.url ?? null,
    version: measure.version ?? null,
    scoring: measure.scoring ?? null,
    library: measure.library ?? [],
    group: measure.group ?? [],
  };
}

/** `sha256:<hex>` over the logic of a vendored bundle. Throws when it holds no Measure or a Library has no ELM. */
export function logicSha256Of(bundle) {
  const resources = (bundle?.entry ?? []).map((e) => e?.resource).filter(Boolean);
  const measures = resources.filter((r) => r.resourceType === "Measure");
  if (measures.length === 0) throw new Error("the bundle holds no Measure, so it has no logic to hash");
  const key = (l) => `${l.url}|${l.version}`;
  const libraries = resources
    .filter((r) => r.resourceType === "Library")
    .map(libraryLogic)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const logic = { libraries, measures: measures.map(measureLogic) };
  return `sha256:${createHash("sha256").update(canonicalJson(logic), "utf8").digest("hex")}`;
}
