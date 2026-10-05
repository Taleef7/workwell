/**
 * The pure half of building a WorkWell translation (decision 3, C3a): name it, apply WorkWell's edits to
 * CMS's CQL, strip the compiled ELM, assemble the bundle and write its manifest. No disk, no translator,
 * no network — `run/cli/build-derived.ts` does those and calls these.
 *
 * What is stored in the repo is only ever WorkWell's: the edits file holds WorkWell's replacement text
 * and a hash of the CMS lines it replaces (never those lines), and the main library's ELM is stripped of
 * the keys that carry CMS's CQL text (`annotation`, `locator`). CMS's six shared libraries are copied byte-for-byte from the
 * committed official artifact, because a recompile of them would differ from CMS's ELM in bytes (include
 * paths, `identifier.system`, choice order) while meaning the same thing — and "unchanged" is checked
 * by those bytes (`derivedIdentityProblems`).
 */
import { createHash } from "node:crypto";
import type { DerivedManifestBlock, OfficialArtifact, OfficialManifest } from "../wiring/official-artifacts.ts";
import { DERIVED_CANONICAL_PREFIX, DERIVED_LABEL_PREFIX, libraryElmSha256, rewriteDerivedIdentity, type DerivedIdentity } from "./derived-identity.ts";

const sha256 = (data: string | Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const lf = (text: string): string => text.replace(/\r\n/g, "\n");
const SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * The identity of the `revision`th translation of a measure for one measurement year. The version
 * `ww-<year>.<revision>` can never be confused with CMS's `1.0.000` or the QDM `15.0.000`, and the name
 * says, in the one token every screen shows, that the logic is WorkWell's.
 */
export function translationIdentity(catalogId: string, year: number, derivedFrom: string, revision = 1): DerivedIdentity {
  if (!/^[a-z0-9]+$/.test(catalogId)) throw new Error(`catalog id '${catalogId}' must be lower-case letters and digits`);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new Error(`year '${year}' must be a four-digit year`);
  if (!Number.isInteger(revision) || revision < 1) throw new Error(`revision '${revision}' must be a positive integer`);
  if (!derivedFrom.trim()) throw new Error("derivedFrom must name the CMS measure (e.g. CMS137v15)");
  // The same prefix the router requires of the label (`derivedIdentityProblems`): one source for both.
  const title = `${DERIVED_LABEL_PREFIX}${derivedFrom}`;
  return {
    url: `${DERIVED_CANONICAL_PREFIX}${catalogId}:translation`,
    version: `ww-${year}.${revision}`,
    name: `WorkWell${catalogId.toUpperCase()}Translation${year}`,
    title,
    derivedFrom,
    effectivePeriod: { start: `${year}-01-01`, end: `${year}-12-31` },
  };
}

/**
 * One WorkWell change to a library's CQL: replace lines `startLine..endLine` (1-based, inclusive, of the
 * LF-normalised source) with `replacement`. `anchorSha256` is the hash of the lines being replaced, so the
 * edit refuses to land anywhere but on the exact CMS text it was written against — and so the edits file
 * can be committed without CMS's lines in it. `replacement` is the span's new text without a trailing
 * newline; "" deletes the span. `reason` is optional prose for the reviewer.
 */
export interface CqlEdit {
  library: string;
  anchorSha256: string;
  startLine: number;
  endLine: number;
  replacement: string;
  reason?: string;
}

const EDIT_KEYS = new Set(["library", "anchorSha256", "startLine", "endLine", "replacement", "reason"]);

/** Validate an edits file's parsed JSON. "No edits" is an explicit `[]`, never a missing file. */
export function parseEdits(json: unknown): CqlEdit[] {
  if (!Array.isArray(json)) throw new Error("the edits file must hold a JSON array (use [] for no edits)");
  return json.map((raw, index) => {
    const at = `edit ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${at} is not an object`);
    const edit = raw as Record<string, unknown>;
    // An unknown key is refused rather than ignored: a misspelt `replacement` would otherwise read as
    // "this edit has no replacement" only if it were also required, and a stray key is a mistake either way.
    const unknown = Object.keys(edit).filter((k) => !EDIT_KEYS.has(k));
    if (unknown.length > 0) throw new Error(`${at} has unknown key(s) ${unknown.join(", ")}`);
    if (typeof edit["library"] !== "string" || !edit["library"]) throw new Error(`${at} names no library`);
    if (typeof edit["anchorSha256"] !== "string" || !SHA256.test(edit["anchorSha256"])) throw new Error(`${at} (${edit["library"]}): anchorSha256 must be sha256:<64 hex>`);
    for (const key of ["startLine", "endLine"] as const) {
      if (!Number.isInteger(edit[key]) || (edit[key] as number) < 1) throw new Error(`${at} (${edit["library"]}): ${key} must be a positive integer`);
    }
    if (typeof edit["replacement"] !== "string") throw new Error(`${at} (${edit["library"]}): replacement must be a string ("" deletes the span)`);
    if (edit["reason"] !== undefined && typeof edit["reason"] !== "string") throw new Error(`${at} (${edit["library"]}): reason must be a string`);
    return edit as unknown as CqlEdit;
  });
}

function splitLines(cql: string): { lines: string[]; trailingNewline: boolean } {
  const text = lf(cql);
  const trailingNewline = text.endsWith("\n");
  return { lines: (trailingNewline ? text.slice(0, -1) : text).split("\n"), trailingNewline };
}

/** The anchor an edit of lines `startLine..endLine` of `cql` must carry. */
export function spanSha256(cql: string, startLine: number, endLine: number): string {
  return sha256(splitLines(cql).lines.slice(startLine - 1, endLine).join("\n"));
}

/**
 * Apply `edits` to one library's CQL. Every anchor is checked against the ORIGINAL text before anything
 * changes, then the spans are replaced bottom-up, so an edit that adds or removes lines never moves the
 * lines a later (higher) edit was anchored to. Overlapping spans are refused: their order would be a
 * guess. `[]` returns the input exactly as given.
 */
export function applyEdits(cql: string, edits: readonly CqlEdit[]): string {
  if (edits.length === 0) return cql;
  const { lines, trailingNewline } = splitLines(cql);
  for (const edit of edits) {
    const where = `${edit.library} lines ${edit.startLine}-${edit.endLine}`;
    if (edit.startLine > edit.endLine || edit.endLine > lines.length) {
      throw new Error(`edit of ${where} is outside the source's ${lines.length} lines`);
    }
    const actual = sha256(lines.slice(edit.startLine - 1, edit.endLine).join("\n"));
    if (actual !== edit.anchorSha256) {
      throw new Error(`edit of ${where} is anchored to ${edit.anchorSha256}, but those lines hash to ${actual}; the CQL is not the text the edit was written against`);
    }
  }
  const ordered = [...edits].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.startLine <= ordered[i - 1]!.endLine) {
      throw new Error(`edits of ${ordered[i - 1]!.library} lines ${ordered[i - 1]!.startLine}-${ordered[i - 1]!.endLine} and ${ordered[i]!.startLine}-${ordered[i]!.endLine} overlap`);
    }
  }
  const out = [...lines];
  for (const edit of ordered.reverse()) {
    out.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...(edit.replacement === "" ? [] : lf(edit.replacement).split("\n")));
  }
  return out.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * Drop ELM's `annotation` and `locator` at every depth, the same walk as `stripAnnotations` in
 * `scripts/vendor-official-measure.mjs`. `annotation` holds CMS's CQL text (the `s` narrative) and
 * `locator` its positions; committing either would commit CMS's CQL.
 *
 * `localId` is KEPT, unlike the vendor script: it is a bare node number with no CQL in it, and fqm reads
 * each define's value by it. Stripped, every define's `raw` is null and the MADiE define-value check (the
 * evidence a translation reproduces CMS's logic define by define) cannot run on the translation.
 */
export function stripElmDebugKeys<T>(elm: T): T {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node)) {
        if (key === "annotation" || key === "locator") continue;
        out[key] = strip((node as Record<string, unknown>)[key]);
      }
      return out;
    }
    return node;
  };
  return strip(elm) as T;
}

/** The vendor script's encoding of ELM into `Library.content[].data`. */
export const encodeElm = (elm: unknown): string => Buffer.from(JSON.stringify(elm), "utf8").toString("base64");

interface Resource {
  resourceType?: string;
  [key: string]: unknown;
}
interface Bundle {
  entry?: Array<{ resource?: Resource }>;
}

export interface AssembledTranslation<T> {
  bundle: T;
  /** CMS's libraries carried unchanged, each pinned by the hash of its ELM, in bundle order. */
  unchangedLibraries: DerivedManifestBlock["unchangedLibraries"];
}

/**
 * The translation's bundle: a copy of CMS's committed (already reduced and stripped) bundle in which the
 * main library's ELM is replaced by OURS, stripped, then given the translation's identity. The Measure
 * and the shared libraries are carried as they are; nothing else changes.
 */
export function assembleTranslationBundle<T extends Bundle>(
  base: T,
  compiledMainElm: { library: { identifier: { id?: unknown; version?: unknown } } & Record<string, unknown> },
  identity: DerivedIdentity,
): AssembledTranslation<T> {
  const copy = JSON.parse(JSON.stringify(base)) as T;
  const resources = (copy.entry ?? []).map((e) => e.resource).filter((r): r is Resource => !!r);
  // fqm puts a bundle's own ValueSets ahead of the sidecar's, so one carried over would score the
  // translation with CMS's codes (the router's D9 refuses it too; this refuses it before anything is written).
  const stray = [...new Set(resources.map((r) => String(r.resourceType)).filter((t) => t !== "Measure" && t !== "Library"))];
  if (stray.length > 0) throw new Error(`the base bundle carries ${stray.join(", ")}; a translation holds only a Measure and its Libraries`);
  const measure = resources.find((r) => r.resourceType === "Measure");
  if (!measure) throw new Error("the base bundle has no Measure");
  const mainUrl = ((measure["library"] as string[] | undefined) ?? [])[0];
  const main = resources.find((r) => r.resourceType === "Library" && (r["url"] === mainUrl || `${r["url"]}|${r["version"]}` === mainUrl));
  if (!main) throw new Error(`Measure.library '${mainUrl}' names no library in the base bundle`);
  // The compiled ELM must be the main library's: dropping another library's ELM into the main slot would
  // assemble a bundle whose identity checks pass over the wrong logic.
  const compiledId = compiledMainElm.library.identifier;
  if (compiledId.id !== main["name"] || compiledId.version !== main["version"]) {
    throw new Error(`the compiled ELM is ${String(compiledId.id)}|${String(compiledId.version)}, not the main library ${String(main["name"])}|${String(main["version"])}`);
  }
  main["content"] = [{ contentType: "application/elm+json", data: encodeElm(stripElmDebugKeys(compiledMainElm)) }];
  const unchangedLibraries = resources
    .filter((r) => r.resourceType === "Library" && r !== main)
    .map((l) => {
      const elmSha256 = libraryElmSha256(l);
      if (!elmSha256) throw new Error(`shared library ${String(l["name"])} has no ELM to pin`);
      return { name: String(l["name"]), version: String(l["version"]), elmSha256 };
    });
  return { bundle: rewriteDerivedIdentity(copy, identity), unchangedLibraries };
}

export interface DerivedManifestInput {
  /** CMS's committed artifact the translation was built on. */
  base: Pick<OfficialArtifact, "manifest">;
  /** The exact bytes written to `bundle.json` (`JSON.stringify(bundle, null, 0) + "\n"`). */
  bundleJson: string;
  identity: DerivedIdentity;
  build: DerivedManifestBlock["build"];
  unchangedLibraries: DerivedManifestBlock["unchangedLibraries"];
  /** `sha256:` of the CMS package the edits were read from (provenance; the package is never committed). */
  packageSha256: string;
  terminologyBlock: NonNullable<OfficialManifest["terminology"]>;
  /** The manifest already committed for this translation, if any: the only source of oracle records. */
  previous?: Pick<OfficialManifest, "sha256" | "terminology" | "derived"> | null;
}

/**
 * The translation's manifest, keyed like an official one (scoring, populations and source are CMS's,
 * because they ARE: the router requires them equal) with `derived` last and no `tests` block.
 *
 * Oracle records are carried forward ONLY when the artifact and its terminology are byte-for-byte the
 * ones the records ran against; otherwise they are cleared, and the router refuses the translation until
 * the checks are re-run. Clearing is reported as a warning, never done silently.
 */
export function derivedManifestFor(input: DerivedManifestInput): { manifest: OfficialManifest; warnings: string[] } {
  const { base, bundleJson, identity, build, unchangedLibraries, packageSha256, terminologyBlock, previous } = input;
  const sha = sha256(bundleJson);
  const warnings: string[] = [];
  const previousOracles = previous?.derived?.oracles ?? [];
  const unchanged = !!previous && previous.sha256 === sha && previous.terminology?.sha256 === terminologyBlock.sha256;
  const oracles = unchanged ? previousOracles : [];
  if (!unchanged && previousOracles.length > 0) {
    warnings.push("oracle records cleared: the artifact changed; re-run derived:check --record");
  }
  const b = base.manifest;
  const manifest: OfficialManifest = {
    catalogId: b.catalogId,
    measureName: identity.name,
    version: identity.version,
    cmsId: null,
    url: identity.url,
    status: "draft",
    effectivePeriod: identity.effectivePeriod,
    scoring: b.scoring,
    populationBasis: b.populationBasis,
    improvementNotation: b.improvementNotation,
    populations: b.populations,
    // CMS's upstream bundle the CQL was read from: the same pinned file the official artifact records.
    source: b.source,
    reduction: {
      keptResourceTypes: ["Measure", "Library"],
      libraryContentTypes: ["application/elm+json"],
      strippedNarratives: true,
      strippedElmAnnotations: true,
      strippedValueSets: true,
      rawBytes: (b.reduction as { rawBytes?: unknown }).rawBytes ?? null,
      vendoredBytes: Buffer.byteLength(bundleJson),
    },
    terminology: terminologyBlock,
    sha256: sha,
    derived: {
      label: identity.title,
      derivedFrom: { ecqm: identity.derivedFrom, packageSha256 },
      base: { catalogId: b.catalogId, manifestSha256: b.sha256 },
      build,
      unchangedLibraries,
      oracles,
    },
  };
  return { manifest, warnings };
}
