/**
 * `pnpm derived:check` — run the checks a WorkWell translation must have passed before the router will
 * route it (D7 in `executor-router.ts`), and, with `--record`, write their records into its manifest. It
 * is the only writer of `derived.oracles`.
 *
 *   cypress-deck             the translation, on its OWN terminology, agrees with the Cypress deck's
 *                            expected results on every rate and every stratum of every patient — plus a
 *                            built-in break ("Initial Population" forced false) that must lower agreement,
 *                            or the oracle is not looking at the translation at all.
 *   terminology-equivalence  its sidecar equals the deck's value-set export at the release on every
 *                            declared value set, and it changed exactly the sets the release changed. The
 *                            export is the Cypress/CVU team's (for CMS137v15, the 2027 deck's
 *                            `value-set-codes.csv`, eCQM Update 2026-05-14): their copy of that VSAC
 *                            release, not a code list from the measure's steward.
 *   (package)                the CMS package it was translated from hashes to `derivedFrom.packageSha256`,
 *                            and every value set that package's CQL declares is one the translation declares
 *                            (`--package-cql-dir`, required with `--record`).
 *   (--madie)                on CMS's MADiE deck and CMS's own 2026 value sets, the translation's logic
 *                            gives CMS's status, rates and strata on every case, and CMS's value for every
 *                            define EXCEPT exactly the differences `madie-expected-differences.json` lists
 *                            (none when the file is absent; each listed one must be seen). Two breaks must
 *                            move results: the main library's "Initial Population", and each changed
 *                            library's edited defines (or the deck is not running WorkWell's copy). When
 *                            `edits.json` is not `[]`, the edit's own `edit-cases.json` patients must give
 *                            CMS's stated answer on CMS's logic and the translation's on the translation.
 *                            Credential-free; reported, never recorded.
 *
 * Each record names the exact bundle and sidecar it ran against, hashed from the bytes ON DISK — never
 * copied from the manifest — so a record cannot vouch for an artifact it did not run.
 *
 * Prints counts and hashes, never a patient name. The one exception is a MADiE define-value difference
 * that is unlisted or listed-but-unseen: it is printed as its case uuid, define key and the two compared
 * strings cut to 80 characters, because that is the exact entry `madie-expected-differences.json` would
 * need. Those are values from CMS's synthetic MADiE patients (booleans and dates for CMS130's edit), and a
 * code-valued define could show part of a code. Exit 0 pass, 1 any failure or refusal (nothing is
 * written), 2 usage. DB-less; fqm runs in a worker thread (deck) or through `standards/official-cases.ts`
 * (MADiE), never imported here.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agreementPasses,
  importDeckPatients,
  readCypressDeck,
  renderAgreementMarkdown,
  rowsAgreeing,
  runAgreement,
  type AgreementCalculate,
  type ImportDeckDeps,
} from "../../standards/cypress-agreement.ts";
import {
  loadOfficialMeasureCases,
  runOfficialMeasureCases,
  type FqmCalculate,
  type FhirBundle,
  type LoadedOfficialMeasure,
  type OfficialMeasureId,
  type OfficialMeasureRun,
} from "../../standards/official-cases.ts";
import {
  breakInitialPopulation,
  compareRuns,
  COMPILED_GATE_MEASURES,
  PINNED_STATEMENT_RESULTS,
  verifyUpstreamBundle,
  type CompiledGateMeasure,
  type StatementDifference,
} from "./compiled-cases.ts";
import { declaredPopulations, EDIT_CASES_FILE, editCaseSetProblems, parseEditCases, runEditCases, type EditCaseSet } from "../../standards/edit-cases.ts";
import { withCompiledElm, type CompiledLibrary } from "../../standards/qicore-compile.ts";
import { compareSidecarToCypressCsv, CSV_SYSTEM_FOR_OID } from "../../standards/terminology-equivalence.ts";
import { REQUIRED_OFFICIAL_CASE_COUNTS } from "./official-cases.ts";
import { createFqmWorker, type FqmWorker } from "../../wiring/fqm-worker.ts";
import {
  artifactKind,
  loadDerivedArtifact,
  loadOfficialArtifact,
  type DerivedChangedLibrary,
  type DerivedManifestBlock,
  type OfficialArtifact,
} from "../../wiring/official-artifacts.ts";
import { expandArtifactTerminology, oidFromValueSetUrl, requiredOids, type ExpandValueSet } from "../../wiring/official-executor-adapter.ts";
import { officialMeasureSemantics } from "../../wiring/official-measure-semantics.ts";
import { loadOfficialTerminology, type LoadedTerminology } from "../../wiring/official-terminology.ts";

export const USAGE =
  "Usage: pnpm derived:check --catalog-id <id> --cypress-bundle <dir> --package <zip> [--package-cql-dir <dir>]" +
  " [--csv <path>] [--release <name>] [--record] [--madie] [--content-dir .official-content] [--limit N]\n" +
  "  With --madie and without --record, --cypress-bundle and --package may be omitted: the deck and" +
  " terminology oracles (and the sidecar checks) are then skipped. --record also needs --package-cql-dir.";

export class DerivedCheckUsageError extends Error {
  override readonly name = "DerivedCheckUsageError";
}

/** A precondition that does not hold: the check stops, prints why, and writes nothing. */
class Refusal extends Error {
  override readonly name = "Refusal";
}

export interface DerivedCheckArgs {
  catalogId: string;
  cypressBundle?: string;
  packagePath?: string;
  packageCqlDir?: string;
  csv?: string;
  release?: string;
  record: boolean;
  madie: boolean;
  contentDir: string;
  limit: number;
}

export function parseArgs(argv: string[]): DerivedCheckArgs {
  const values = new Map<string, string>();
  let record = false;
  let madie = false;
  const valued = ["--catalog-id", "--cypress-bundle", "--package", "--package-cql-dir", "--csv", "--release", "--content-dir", "--limit"];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--record") record = true;
    else if (arg === "--madie") madie = true;
    else if (arg === "--help" || arg === "-h") throw new DerivedCheckUsageError(USAGE);
    else if (valued.includes(arg)) {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new DerivedCheckUsageError(`${arg} needs a value\n${USAGE}`);
      if (values.has(arg)) throw new DerivedCheckUsageError(`${arg} given twice\n${USAGE}`);
      values.set(arg, next);
    } else throw new DerivedCheckUsageError(`unknown argument '${arg}'\n${USAGE}`);
  }
  const catalogId = values.get("--catalog-id");
  if (!catalogId) throw new DerivedCheckUsageError(`--catalog-id is required\n${USAGE}`);
  if (!/^[a-z0-9]+$/.test(catalogId)) throw new DerivedCheckUsageError(`--catalog-id takes a catalog id such as cms137\n${USAGE}`);
  const cypressBundle = values.get("--cypress-bundle");
  const packagePath = values.get("--package");
  // The deck-free mode exists for CI, which has neither the licensed deck nor (uncredentialed) a sidecar.
  // It can only ever REPORT: a record needs every oracle, and every oracle needs the deck.
  const deckFree = madie && !record;
  if (!deckFree) {
    if (!cypressBundle) throw new DerivedCheckUsageError(`--cypress-bundle is required${record ? " with --record" : " unless --madie runs alone"}\n${USAGE}`);
    if (!packagePath) throw new DerivedCheckUsageError(`--package is required${record ? " with --record" : " unless --madie runs alone"}\n${USAGE}`);
  }
  // Refused rather than ignored: each only means something to a check that would not run.
  for (const flag of ["--csv", "--release"]) {
    if (values.has(flag) && !cypressBundle) throw new DerivedCheckUsageError(`${flag} needs --cypress-bundle: the terminology oracle runs with the deck\n${USAGE}`);
  }
  if (values.has("--package-cql-dir") && !packagePath) throw new DerivedCheckUsageError(`--package-cql-dir needs --package\n${USAGE}`);
  // A record vouches for the translation on every check this tool has; one written with the package's
  // value-set declarations unchecked would vouch for a check that never ran. Without --record the run
  // only reports, and says loudly that the declarations were skipped.
  if (record && !values.has("--package-cql-dir")) {
    throw new DerivedCheckUsageError(`--package-cql-dir is required with --record: a record is written only when the package's value-set declarations were checked too\n${USAGE}`);
  }
  const limitText = values.get("--limit") ?? "20";
  const limit = Number(limitText);
  if (!Number.isInteger(limit) || limit < 0) throw new DerivedCheckUsageError(`--limit takes a whole number\n${USAGE}`);
  return {
    catalogId,
    ...(cypressBundle ? { cypressBundle } : {}),
    ...(packagePath ? { packagePath } : {}),
    ...(values.has("--package-cql-dir") ? { packageCqlDir: values.get("--package-cql-dir")! } : {}),
    ...(values.has("--csv") ? { csv: values.get("--csv")! } : {}),
    ...(values.has("--release") ? { release: values.get("--release")! } : {}),
    record,
    madie,
    contentDir: values.get("--content-dir") ?? ".official-content",
    limit,
  };
}

export interface DerivedCheckDeps {
  cwd: string;
  /**
   * The directory holding `<catalogId>/{bundle.json,manifest.json,terminology.json}`, and the files
   * `--madie` reads beside them: `edits.json`, `madie-expected-differences.json`, `edit-cases.json`.
   */
  derivedRoot: string;
  loadDerived: (catalogId: string) => OfficialArtifact | null;
  loadOfficial: (catalogId: string) => OfficialArtifact | null;
  loadTerminology: (artifact: OfficialArtifact) => LoadedTerminology;
  semantics: (catalogId: string) => { trustMetaProfile?: boolean } | undefined;
  importDeps?: ImportDeckDeps;
  /** The deck calculation. Absent: a worker thread, closed when the check ends. */
  calculate?: AgreementCalculate;
  verifyUpstream: (contentDir: string, measure: OfficialMeasureId) => void;
  loadCases: (contentDir: string, measure: OfficialMeasureId) => LoadedOfficialMeasure;
  runCases: typeof runOfficialMeasureCases;
  pinnedStatements: Readonly<Record<string, number>>;
  requiredCases: Readonly<Record<string, number>>;
  log: (message: string) => void;
  error: (message: string) => void;
}

const DERIVED_ROOT = fileURLToPath(new URL("../../../measures/derived/", import.meta.url));

export function defaultDerivedCheckDeps(): DerivedCheckDeps {
  return {
    cwd: process.cwd(),
    derivedRoot: DERIVED_ROOT,
    loadDerived: loadDerivedArtifact,
    loadOfficial: loadOfficialArtifact,
    loadTerminology: loadOfficialTerminology,
    semantics: officialMeasureSemantics,
    verifyUpstream: verifyUpstreamBundle,
    loadCases: loadOfficialMeasureCases,
    runCases: runOfficialMeasureCases,
    pinnedStatements: PINNED_STATEMENT_RESULTS,
    requiredCases: REQUIRED_OFFICIAL_CASE_COUNTS,
    log: console.log,
    error: console.error,
  };
}

type Oracle = DerivedManifestBlock["oracles"][number];
type FqmOutput = Awaited<ReturnType<FqmCalculate>>;
type Bundle = OfficialArtifact["bundle"];

const sha256 = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function sha256OfFile(file: string, what: string): string {
  if (!existsSync(file)) throw new Refusal(`${what} is missing (${file})`);
  return sha256(readFileSync(file));
}

const decode = (data: string): string => Buffer.from(data, "base64").toString("utf8");

const resourcesOf = (bundle: { entry?: Array<{ resource?: Record<string, unknown> }> }): Array<Record<string, unknown>> =>
  (bundle.entry ?? []).map((e) => e.resource).filter((r): r is Record<string, unknown> => !!r);

/** The library `Measure.library` names — the one a translation renames and a break must hit. */
export function mainLibraryName(bundle: { entry?: Array<{ resource?: Record<string, unknown> }> }): string {
  const resources = resourcesOf(bundle);
  const measure = resources.find((r) => r["resourceType"] === "Measure");
  const ref = ((measure?.["library"] as string[] | undefined) ?? [])[0];
  const main = resources.find((r) => r["resourceType"] === "Library" && (r["url"] === ref || `${String(r["url"])}|${String(r["version"])}` === ref));
  if (!main) throw new Error(`Measure.library '${String(ref)}' names no library in the bundle`);
  return String(main["name"]);
}

/**
 * A copy of the bundle whose main library's "Initial Population" is the literal `false` — the same break
 * `test:compiled-cases` uses, applied to a bundle's ELM rather than freshly compiled libraries.
 */
export function withInitialPopulationBroken<T extends Bundle | FhirBundle>(bundle: T): T {
  const asLike = bundle as unknown as { entry?: Array<{ resource?: Record<string, unknown> }> };
  const libraries: CompiledLibrary[] = resourcesOf(asLike)
    .filter((r) => r["resourceType"] === "Library")
    .map((library) => {
      const data = ((library["content"] as Array<{ contentType?: string; data?: string }> | undefined) ?? []).find((c) => c.contentType === "application/elm+json")?.data;
      if (!data) throw new Error(`Library ${String(library["name"])} has no ELM to break`);
      return { name: String(library["name"]), version: String(library["version"]), elm: JSON.parse(decode(data)) as CompiledLibrary["elm"], warnings: [] };
    });
  return withCompiledElm(asLike, breakInitialPopulation(libraries, mainLibraryName(asLike))) as unknown as T;
}

const ELM_DEBUG_KEYS = new Set(["annotation", "locator", "localId"]);

/** A library's ELM as JSON text with CMS's CQL positions and fqm's statement ids removed. */
function strippedElmText(library: Record<string, unknown>): string {
  const data = ((library["content"] as Array<{ contentType?: string; data?: string }> | undefined) ?? []).find((c) => c.contentType === "application/elm+json")?.data;
  if (!data) throw new Error(`Library ${String(library["name"])} ${String(library["version"])} has no ELM`);
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).filter(([key]) => !ELM_DEBUG_KEYS.has(key)).map(([key, value]) => [key, strip(value)]));
    }
    return node;
  };
  return JSON.stringify(strip(JSON.parse(decode(data))));
}

/**
 * The bundle the MADiE comparison runs the translation as: the translation's Measure, its MAIN library and
 * every CHANGED library it lists (`derived.changedLibraries`), CMS's upstream copy of every other shared
 * library it carries, and everything else upstream ships (its ValueSets above all). That is what makes the
 * comparison about LOGIC: both runs see CMS's own 2026 terminology, so any difference is WorkWell's ELM.
 *
 * Why upstream's shared libraries rather than the translation's: the translation carries CMS's COMMITTED
 * copies, which (like every vendored artifact) have no `localId`, and without one fqm reports no value and
 * a different label for every define — measured, 2346 of 2970 differing on cms137 with the logic
 * untouched. So each carried library is first proven to BE upstream's — its ELM byte-equal once
 * `annotation`, `locator` and `localId` are stripped from both — and only then is upstream's own copy,
 * localIds included, run in its place. A carried library that differs, or that upstream lacks, is refused
 * by name: running upstream's copy would silently score logic the translation does not contain.
 *
 * A changed library is the opposite case: it IS different logic, so it runs as the translation's own copy
 * (which keeps its `localId`s, so its defines report values). Refused: an entry whose `from` library
 * upstream does not hold (there would be nothing of CMS's to compare it against), and an entry the
 * translation does not carry (the manifest would describe logic the bundle lacks).
 */
export function translatedUpstreamBundle(upstream: FhirBundle, translation: Bundle, derived: Pick<DerivedManifestBlock, "changedLibraries">): FhirBundle {
  const asLike = translation as unknown as { entry?: Array<{ resource?: Record<string, unknown> }> };
  const main = mainLibraryName(asLike);
  const key = (r: Record<string, unknown>) => `${String(r["name"])}|${String(r["version"])}`;
  const upstreamLibraries = new Map(upstream.entry.filter((e) => e.resource.resourceType === "Library").map((e) => [key(e.resource), e]));
  const carried = new Set(resourcesOf(asLike).filter((r) => r["resourceType"] === "Library").map(key));
  const changed = new Set<string>();
  for (const library of derived.changedLibraries ?? []) {
    const ours = `${library.name}|${library.version}`;
    const from = `${library.from.name}|${library.from.version}`;
    if (!upstreamLibraries.has(from)) throw new Error(`changed library ${ours} was edited from ${from}, which CMS's upstream bundle does not hold`);
    if (!carried.has(ours)) throw new Error(`changed library ${ours} is listed in changedLibraries, but the translation does not carry it`);
    changed.add(ours);
  }
  const ours: FhirBundle["entry"] = [];
  for (const entry of JSON.parse(JSON.stringify(translation.entry)) as FhirBundle["entry"]) {
    const resource = entry.resource;
    if (resource.resourceType === "Measure" || (resource.resourceType === "Library" && (resource["name"] === main || changed.has(key(resource))))) {
      ours.push(entry);
      continue;
    }
    if (resource.resourceType !== "Library") continue;
    const theirs = upstreamLibraries.get(key(resource));
    if (!theirs) throw new Error(`shared library ${key(resource)} is carried by the translation but absent from CMS's upstream bundle`);
    if (strippedElmText(resource) !== strippedElmText(theirs.resource)) {
      throw new Error(`shared library ${key(resource)} differs from CMS's upstream copy once annotation, locator and localId are stripped`);
    }
    ours.push(JSON.parse(JSON.stringify(theirs)) as FhirBundle["entry"][number]);
  }
  const kept = upstream.entry.filter((e) => e.resource.resourceType !== "Measure" && e.resource.resourceType !== "Library");
  return { ...upstream, entry: [...ours, ...kept] };
}

/**
 * The translation renames its main library and each changed library, so fqm reports their defines under
 * the new names and the per-statement comparison would see two disjoint sets. Renamed back IN PLACE (once
 * per pair) — a JSON copy would turn every cql-execution value into a plain object and make
 * `canonicalValue` call them all different.
 */
function renameLibrary(output: FqmOutput | undefined, from: string, to: string): void {
  if (from === to) return;
  for (const result of output?.results ?? []) {
    for (const detail of (result.detailedResults ?? []) as Array<{ statementResults?: Array<{ libraryName?: string }> }>) {
      for (const statement of detail.statementResults ?? []) if (statement.libraryName === from) statement.libraryName = to;
    }
  }
}

// ---- a changed library's edited defines, and the break that proves they run ---------------------------

interface ElmDef {
  name?: string;
  type?: string;
  operand?: unknown;
  expression?: unknown;
}
type ElmJson = { library: { statements?: { def?: ElmDef[] } } };

/**
 * What a def's comparison ignores. `localId`, `locator` and `annotation` are positions and CMS's CQL text;
 * `resultTypeName`/`resultTypeSpecifier` are the translator's type annotations, not logic. Calibrated on
 * cms130 (2026-10-09): our UNEDITED compile of AdvancedIllnessandFrailty 1.27.000 equals CMS's on all 7
 * defs under this canonical form, and the one-phrase `overlaps` edit differs on exactly the one define it
 * touches. The library identifier is never compared: only `statements.def` is.
 */
const DEF_NOISE = new Set(["localId", "locator", "annotation", "resultTypeName", "resultTypeSpecifier"]);
function canonicalDef(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canonicalDef);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.keys(node)
        .filter((key) => !DEF_NOISE.has(key))
        .sort()
        .map((key) => [key, canonicalDef((node as Record<string, unknown>)[key])]),
    );
  }
  return node;
}

/** A def's identity: a define by name; a function by name AND operand types, since overloads share a name. */
const defKey = (def: ElmDef): string =>
  def.type === "FunctionDef" ? `function ${String(def.name)}(${JSON.stringify(canonicalDef(def.operand ?? []))})` : `define ${String(def.name)}`;

function elmOfLibrary(library: Record<string, unknown>): ElmJson {
  const data = ((library["content"] as Array<{ contentType?: string; data?: string }> | undefined) ?? []).find((c) => c.contentType === "application/elm+json")?.data;
  if (!data) throw new Error(`Library ${String(library["name"])} ${String(library["version"])} has no ELM`);
  return JSON.parse(decode(data)) as ElmJson;
}

export interface DifferingDefine {
  /** `define <name>` or `function <name>(<operand types>)`. */
  key: string;
  name: string;
  /** `both`: present on each side and different; otherwise the one side that has it. */
  in: "both" | "ours" | "cms";
}

/** The defs of a changed library (`ours`) that differ from CMS's copy of the library it was edited from. */
export function differingDefines(ours: ElmJson, cms: ElmJson): DifferingDefine[] {
  const index = (elm: ElmJson) => new Map((elm.library.statements?.def ?? []).map((d) => [defKey(d), d]));
  const mine = index(ours);
  const theirs = index(cms);
  const out: DifferingDefine[] = [];
  for (const [key, def] of mine) {
    const other = theirs.get(key);
    if (!other) out.push({ key, name: String(def.name), in: "ours" });
    else if (JSON.stringify(canonicalDef(def)) !== JSON.stringify(canonicalDef(other))) out.push({ key, name: String(def.name), in: "both" });
  }
  for (const [key, def] of theirs) if (!mine.has(key)) out.push({ key, name: String(def.name), in: "cms" });
  return out;
}

/**
 * A copy of the translation whose changed library `library` has every def that differs from CMS's `from`
 * replaced by the ELM `Null` literal — the break that proves the MADiE run executes WorkWell's copy.
 *
 * Null, not a negation or a boolean constant: `Not` keeps a null null and is only defined on a Boolean,
 * and a constant `true`/`false` equals the define's real value on every case where it already was that
 * value. A null differs from every value the define can actually take wherever it is non-null, and an
 * edited Boolean define (CMS130's `exists`) is never null on a case that evaluates it. cql-execution runs
 * every main-library define for every patient and evaluates every operand of `and`/`or` (no
 * short-circuit), so a define the main library reaches is evaluated on every case — and its fqm value
 * (read by the def's own `localId`, which stays) moves on each one. A define the deck only ever sees as
 * null would not move, and the check then fails: correctly, since the deck cannot see that edit.
 *
 * Returns the broken defs' keys; none (an edit that changed no def, or only deleted one) is the caller's
 * failure to report.
 */
export function withChangedLibraryBroken<T extends Bundle | FhirBundle>(translation: T, upstream: FhirBundle, library: DerivedChangedLibrary): { bundle: T; broken: string[]; differing: DifferingDefine[] } {
  const copy = JSON.parse(JSON.stringify(translation)) as T;
  const asLike = copy as unknown as { entry?: Array<{ resource?: Record<string, unknown> }> };
  const target = resourcesOf(asLike).find((r) => r["resourceType"] === "Library" && r["name"] === library.name && r["version"] === library.version);
  if (!target) throw new Error(`changed library ${library.name}|${library.version} is not in the translation`);
  const from = upstream.entry.map((e) => e.resource).find((r) => r.resourceType === "Library" && r["name"] === library.from.name && r["version"] === library.from.version);
  if (!from) throw new Error(`CMS's upstream bundle has no ${library.from.name}|${library.from.version}`);
  const elm = elmOfLibrary(target);
  const differing = differingDefines(elm, elmOfLibrary(from));
  const breakable = new Set(differing.filter((d) => d.in !== "cms").map((d) => d.key));
  const broken: string[] = [];
  for (const def of elm.library.statements?.def ?? []) {
    if (!breakable.has(defKey(def))) continue;
    def.expression = { type: "Null" };
    broken.push(defKey(def));
  }
  target["content"] = [{ contentType: "application/elm+json", data: Buffer.from(JSON.stringify(elm), "utf8").toString("base64") }];
  return { bundle: copy, broken, differing };
}

// ---- the define-value differences a translation is allowed --------------------------------------------

export const EXPECTED_DIFFERENCES_FILE = "madie-expected-differences.json";

/** One entry of `madie-expected-differences.json`: a `compareRuns` difference, plus why it is right. */
export interface ExpectedDifference extends StatementDifference {
  reason: string;
}

const identityOf = (d: StatementDifference): string => JSON.stringify([d.case, d.key, d.cms, d.ours]);

/**
 * Read `madie-expected-differences.json`: a JSON array of `{ case, key, cms, ours, reason }`, exactly the
 * strings `compareRuns` reports (`null` for a side that reports no such define). Refused: an unknown key, a
 * blank reason (a difference nobody can explain is not "expected"), an entry whose two sides are equal (it
 * is no difference), and a duplicate — the list is a set, matched exactly.
 */
export function parseExpectedDifferences(json: unknown): ExpectedDifference[] {
  if (!Array.isArray(json)) throw new Error("it is not a JSON array");
  const seen = new Set<string>();
  return json.map((raw, index) => {
    const where = `entry ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} is not an object`);
    const entry = raw as Record<string, unknown>;
    const unknown = Object.keys(entry).filter((k) => !["case", "key", "cms", "ours", "reason"].includes(k));
    if (unknown.length > 0) throw new Error(`${where} has unknown key(s) ${unknown.join(", ")}`);
    if (typeof entry["case"] !== "string" || entry["case"] === "") throw new Error(`${where} has no case`);
    if (typeof entry["key"] !== "string" || !/^g\d+\|.+\..+/.test(entry["key"])) throw new Error(`${where} has no key of the form g<group>|<library>.<define>`);
    for (const side of ["cms", "ours"]) {
      if (entry[side] !== null && typeof entry[side] !== "string") throw new Error(`${where}: ${side} must be the compared string, or null where that side reports no such define`);
    }
    if (entry["cms"] === entry["ours"]) throw new Error(`${where}: cms and ours are equal, so it is no difference`);
    if (typeof entry["reason"] !== "string" || entry["reason"].trim() === "") throw new Error(`${where} has no reason`);
    const difference: ExpectedDifference = { case: entry["case"], key: entry["key"], cms: entry["cms"] as string | null, ours: entry["ours"] as string | null, reason: entry["reason"] };
    if (seen.has(identityOf(difference))) throw new Error(`${where} repeats an earlier entry`);
    seen.add(identityOf(difference));
    return difference;
  });
}

/**
 * Observed vs listed, as multisets on (case, key, cms, ours): `missing` were listed but not seen,
 * `unexpected` were seen but not listed. A value that moved shows as one of each — the listed value
 * missing, the new one unexpected — which is what it is.
 */
export function matchExpectedDifferences(observed: readonly StatementDifference[], expected: readonly StatementDifference[]): { missing: StatementDifference[]; unexpected: StatementDifference[] } {
  const remaining = new Map<string, number>();
  for (const d of expected) remaining.set(identityOf(d), (remaining.get(identityOf(d)) ?? 0) + 1);
  const unexpected: StatementDifference[] = [];
  for (const d of observed) {
    const left = remaining.get(identityOf(d)) ?? 0;
    if (left > 0) remaining.set(identityOf(d), left - 1);
    else unexpected.push(d);
  }
  const missing = expected.filter((d) => {
    const left = remaining.get(identityOf(d)) ?? 0;
    if (left === 0) return false;
    remaining.set(identityOf(d), left - 1);
    return true;
  });
  return { missing, unexpected };
}

/** A compared string for a log line: at most 80 characters, and "(absent)" for a side with no such define. */
const clip = (value: string | null): string => (value === null ? "(absent)" : value.length > 80 ? `${value.slice(0, 79)}…` : value);
const describeDifference = (d: StatementDifference): string => `case ${d.case} ${d.key}: CMS's ${clip(d.cms)} · ours ${clip(d.ours)}`;
/** At most this many differences are printed per list; the counts are always whole. */
const PRINTED_DIFFERENCES = 25;

/** Every value-set OID a CMS package's CQL declares (`valueset "…": 'urn:oid:…'`), and how many files said so. */
export function declaredPackageOids(dir: string): { oids: Set<string>; files: number } {
  const oids = new Set<string>();
  let files = 0;
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith(".cql")) {
        files++;
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(/^\s*valueset\s+"(?:[^"\\]|\\.)*"\s*:\s*'([^']+)'/gm)) {
          const id = match[1]!;
          oids.add(id.startsWith("urn:oid:") ? id.slice("urn:oid:".length) : oidFromValueSetUrl(id));
        }
      }
    }
  };
  walk(dir);
  return { oids, files };
}

/**
 * Every value-set OID a CMS package's measure specification lists (`valueSet="…"` in its HQMF, the
 * `.xml` whose root is a QualityMeasureDocument), and how many specifications were read. The HQMF is
 * the measure's own list of the value sets its criteria use; the CQL also declares whatever its shared
 * libraries declare.
 */
export function measureSpecOids(dir: string): { oids: Set<string>; files: number } {
  const oids = new Set<string>();
  let files = 0;
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith(".xml")) {
        const text = readFileSync(full, "utf8");
        if (!/<QualityMeasureDocument[\s>]/.test(text)) continue;
        files++;
        for (const match of text.matchAll(/\bvalueSet="([0-9]+(?:\.[0-9]+)+)"/g)) oids.add(match[1]!);
      }
    }
  };
  walk(dir);
  return { oids, files };
}

export async function main(argv: string[], overrides: Partial<DerivedCheckDeps> = {}): Promise<number> {
  const deps = { ...defaultDerivedCheckDeps(), ...overrides };
  let args: DerivedCheckArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  // Created on first use only: a check that refuses before the deck runs never starts a thread.
  const pool: { worker?: FqmWorker } = {};
  const workerCalculate: AgreementCalculate = (input) => (pool.worker ??= createFqmWorker()).calculate(input);
  try {
    return await check(args, deps, deps.calculate ?? workerCalculate);
  } catch (error) {
    deps.error(`${args.catalogId}: ${error instanceof Error ? error.message : String(error)} — nothing was written`);
    return error instanceof DerivedCheckUsageError ? 2 : 1;
  } finally {
    await pool.worker?.close();
  }
}

async function check(args: DerivedCheckArgs, deps: DerivedCheckDeps, calculate: AgreementCalculate): Promise<number> {
  const id = args.catalogId;
  const log = deps.log;
  const at = (path: string) => resolve(deps.cwd, path);
  const deckMode = args.cypressBundle !== undefined;
  const failures: string[] = [];

  // ---- preconditions ------------------------------------------------------------------------------
  const derived = deps.loadDerived(id);
  const block = derived?.manifest.derived;
  if (!derived || artifactKind(derived) !== "derived" || !block) throw new Refusal(`no WorkWell translation loads from measures/derived/${id}/`);
  const dir = join(deps.derivedRoot, id);
  // Hashed from the bytes on disk, never read from the manifest: the records name these.
  const bundleSha = sha256OfFile(join(dir, "bundle.json"), "the translation's bundle.json");
  if (bundleSha !== derived.manifest.sha256) {
    throw new Refusal(`bundle.json on disk hashes to ${bundleSha}, the manifest pins ${derived.manifest.sha256}`);
  }
  log(`${id}: translation ${block.label} ${derived.manifest.version} · bundle.json ${bundleSha} matches its pin`);
  const official = deps.loadOfficial(id);
  if (!official) throw new Refusal(`CMS's artifact for ${id} does not load from measures/official/`);

  let terminologySha: string | undefined;
  let translationTerminology: Extract<LoadedTerminology, { ok: true }> | undefined;
  let officialTerminology: Extract<LoadedTerminology, { ok: true }> | undefined;
  if (deckMode) {
    const pin = derived.manifest.terminology;
    if (!pin?.sha256 || !pin.file) throw new Refusal("the translation's manifest pins no terminology sidecar");
    terminologySha = sha256OfFile(join(dir, pin.file), `the translation's ${pin.file}`);
    if (terminologySha !== pin.sha256) throw new Refusal(`${pin.file} on disk hashes to ${terminologySha}, the manifest pins ${pin.sha256}`);
    const loaded = deps.loadTerminology(derived);
    if (!loaded.ok) throw new Refusal(`the translation's terminology does not load: ${loaded.problem}`);
    translationTerminology = loaded;
    const officialLoaded = deps.loadTerminology(official);
    if (!officialLoaded.ok) throw new Refusal(`CMS's terminology for ${id} does not load: ${officialLoaded.problem}`);
    officialTerminology = officialLoaded;
    log(`${id}: ${pin.file} ${terminologySha} matches its pin · ${loaded.codesByOid.size} value sets · CMS's sidecar ${officialLoaded.codesByOid.size} value sets`);
  } else {
    log(`${id}: NOTICE no --cypress-bundle — the cypress-deck and terminology-equivalence oracles are skipped, and so are the sidecar checks`);
  }

  // ---- the package it was translated from ---------------------------------------------------------
  if (args.packagePath) {
    const packageSha = sha256OfFile(at(args.packagePath), "--package");
    if (packageSha !== block.derivedFrom.packageSha256) {
      throw new Refusal(`--package hashes to ${packageSha}, but the translation was derived from ${block.derivedFrom.packageSha256}`);
    }
    log(`${id}: package ${packageSha} is the one ${block.derivedFrom.ecqm} was translated from`);
    if (args.packageCqlDir) {
      const { oids: declared, files } = declaredPackageOids(at(args.packageCqlDir));
      const spec = measureSpecOids(at(args.packageCqlDir));
      const required = new Set(requiredOids(derived));
      if (files === 0) failures.push(`--package-cql-dir holds no .cql files, so no declaration was checked`);
      // A declaration is excused only when the package's own measure specification does not list it: a
      // shared QDM library declares value sets for helpers the measure never calls (CMS130 includes
      // CQMCommonQDM for one interval function, and its four hospitalization sets appear nowhere in
      // CMS130's HQMF), and CMS's FHIR draft does not carry that library at all. With no specification in
      // the directory nothing is excused.
      const undeclared = [...declared].filter((oid) => !required.has(oid)).sort();
      const unused = spec.files > 0 ? undeclared.filter((oid) => !spec.oids.has(oid)) : [];
      const missing = undeclared.filter((oid) => !unused.includes(oid));
      const specMissing = [...spec.oids].filter((oid) => !required.has(oid) && !declared.has(oid)).sort();
      const notInPackage = [...required].filter((oid) => !declared.has(oid)).sort();
      log(
        `${id}: package declarations: ${declared.size} value set(s) in ${files} .cql file(s); its measure specification lists ` +
          `${spec.files > 0 ? `${spec.oids.size} in ${spec.files} HQMF file(s)` : "nothing (no HQMF in the directory, so no declaration is excused)"}; ` +
          `the translation declares ${required.size}`,
      );
      if (missing.length) failures.push(`the package declares ${missing.length} value set(s) the translation does not: ${missing.join(", ")}`);
      if (specMissing.length) failures.push(`the package's measure specification lists ${specMissing.length} value set(s) the translation does not declare: ${specMissing.join(", ")}`);
      if (unused.length) {
        log(`${id}: info: ${unused.length} value set(s) the package's CQL declares are not in the translation and not in the measure specification (a shared library's own, unused by the measure): ${unused.join(", ")}`);
      }
      if (notInPackage.length) log(`${id}: info: the translation declares ${notInPackage.length} value set(s) the package's CQL does not: ${notInPackage.join(", ")}`);
    } else {
      log(`${id}: NOTICE ***** no --package-cql-dir: the package's value-set DECLARATIONS were NOT checked, only its hash *****`);
    }
  } else {
    log(`${id}: NOTICE no --package — the package hash and declarations were not checked`);
  }

  // ---- cypress-deck + terminology-equivalence -----------------------------------------------------
  const records: Oracle[] = [];
  if (deckMode && terminologySha && translationTerminology && officialTerminology) {
    const ranAgainst = { artifactSha256: bundleSha, terminologySha256: terminologySha };
    const deck = readCypressDeck(at(args.cypressBundle!), id);
    const semantics = deps.semantics(id);
    if (!semantics) throw new Refusal(`no recorded official semantics for ${id}; production refuses to run it, so no deck run can stand for it`);
    const patients = importDeckPatients(deck, deps.importDeps);
    // The translation's OWN expansions, through the injected loader — the expander the runtime uses
    // reads the same sidecar by the same artifact key.
    const expand: ExpandValueSet = async (oid, artifact) => {
      const loaded = deps.loadTerminology(artifact);
      return loaded.ok ? [...(loaded.codesByOid.get(oid) ?? [])] : [];
    };
    const valueSetCache = await expandArtifactTerminology(derived, expand);
    const common = { deck, patients, valueSetCache, trustMetaProfile: semantics.trustMetaProfile ?? false, calculate, strata: "compare" as const, limit: args.limit };
    const report = await runAgreement({ ...common, artifact: derived });
    log(renderAgreementMarkdown(report, { artifact: `WorkWell translation (${bundleSha}); terminology: its own sidecar`, engine: `trustMetaProfile ${common.trustMetaProfile ? "on" : "off"}`, namePatients: false, limit: args.limit }));
    const broken = await runAgreement({ ...common, artifact: { ...derived, bundle: withInitialPopulationBroken(derived.bundle) } });
    const before = rowsAgreeing(report);
    const after = rowsAgreeing(broken);
    const lowered = after < before;
    log(`${id}: cypress-deck non-vacuity, "Initial Population" forced false → rows agreeing ${before} → ${after} ${lowered ? "(the oracle runs the translation)" : "— FAIL: the oracle is not running the translation"}`);
    const deckPass = agreementPasses(report) && lowered;
    if (!agreementPasses(report)) failures.push(`cypress-deck: ${report.patientsAgreeing}/${report.patients} patients agree on every row`);
    if (!lowered) failures.push("cypress-deck: breaking the translation did not lower agreement");
    records.push({
      name: "cypress-deck",
      inputSha256: deck.inputSha256,
      period: { start: deck.period.start, end: deck.period.end },
      agree: report.patientsAgreeing,
      total: report.patients,
      result: deckPass ? "pass" : "fail",
      ranAgainst,
    });
    log(`${id}: cypress-deck ${report.patientsAgreeing}/${report.patients} · input ${deck.inputSha256} · period ${deck.period.start}..${deck.period.end} — ${deckPass ? "PASS" : "FAIL"}`);

    const csvPath = at(args.csv ?? join(args.cypressBundle!, "value-sets", "value-set-codes.csv"));
    const release = args.release ?? deck.meta.release;
    if (!release) throw new DerivedCheckUsageError(`--release is required: the deck's bundle.json names no value-set release\n${USAGE}`);
    if (!existsSync(csvPath)) throw new Refusal(`the value-set CSV is missing (${csvPath})`);
    const csvBytes = readFileSync(csvPath);
    const completion = derived.manifest.terminology?.completion?.manifest;
    const releaseDate = /\d{4}-\d{2}-\d{2}/.exec(release)?.[0];
    if (completion && releaseDate && !completion.includes(releaseDate)) {
      log(`${id}: NOTICE the translation's terminology names VSAC release ${completion}, the CSV is read at ${release}`);
    }
    const equivalence = compareSidecarToCypressCsv({
      translation: translationTerminology.codesByOid,
      official: officialTerminology.codesByOid,
      csvText: csvBytes.toString("utf8"),
      requiredOids: requiredOids(derived),
      release,
      systemForOid: CSV_SYSTEM_FOR_OID,
    });
    for (const o of equivalence.oids) {
      if (!o.changedByRelease && o.equalToCypress) continue;
      log(
        `  ${o.oid}: cypress ${o.cypress} · CMS's ${o.official} (release +${o.addedByRelease}/−${o.removedByRelease}) · ` +
          `translation ${o.translation} (missing ${o.missingFromTranslation}, extra ${o.extraInTranslation})${o.equalToCypress ? "" : " — DIFFERS"}`,
      );
    }
    for (const problem of equivalence.problems) failures.push(`terminology-equivalence: ${problem}`);
    const period = derived.manifest.effectivePeriod;
    if (!period?.start || !period.end) throw new Refusal("the translation declares no effectivePeriod");
    records.push({
      name: "terminology-equivalence",
      inputSha256: sha256(csvBytes),
      period: { start: period.start, end: period.end },
      agree: equivalence.agree,
      total: equivalence.total,
      result: equivalence.result,
      ranAgainst,
    });
    log(
      `${id}: terminology-equivalence at ${equivalence.release} · csv ${sha256(csvBytes)} · ${equivalence.total} declared value sets · ` +
        `${equivalence.changedByRelease.length} changed by the release · ${equivalence.changedByTranslation.length} changed by the translation · ` +
        `${equivalence.agree}/${equivalence.total} equal to the CSV — ${equivalence.result.toUpperCase()}`,
    );
  }

  // ---- MADiE: the logic, on CMS's own terminology ------------------------------------------------------
  if (args.madie) failures.push(...(await madie(args, deps, derived, block)));

  if (failures.length > 0) {
    for (const failure of failures) deps.error(`${id}: FAIL ${failure}`);
    log(`${id}: derived-check FAIL${args.record ? " — nothing was recorded" : ""}`);
    return 1;
  }
  if (args.record) {
    recordOracles(dir, records, bundleSha, terminologySha!);
    log(`${id}: recorded ${records.map((r) => r.name).join(" + ")} in measures/derived/${id}/manifest.json against ${bundleSha} / ${terminologySha}`);
  }
  log(`${id}: derived-check PASS`);
  return 0;
}

/** A JSON file beside the translation, or why it cannot be read. `absent` is not a problem by itself. */
function readJsonBeside(dir: string, file: string): { absent: true } | { absent: false; json: unknown } | { absent: false; problem: string } {
  const path = join(dir, file);
  if (!existsSync(path)) return { absent: true };
  try {
    return { absent: false, json: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { absent: false, problem: `${file} does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function madie(args: DerivedCheckArgs, deps: DerivedCheckDeps, derived: OfficialArtifact, block: DerivedManifestBlock): Promise<string[]> {
  const id = args.catalogId;
  if (!(COMPILED_GATE_MEASURES as readonly string[]).includes(id)) return [`madie: ${id} has no pinned MADiE define count`];
  const measure = id as CompiledGateMeasure;
  const dir = join(deps.derivedRoot, id);
  const refuse = (problems: string[]) => problems.map((p) => `madie: ${p}`);

  // ---- the files beside the translation, read before anything runs --------------------------------
  // `edits.json` decides whether edit cases are owed. It is the build's input, committed as `[]` when there
  // is no edit, so a missing file is a translation that never said what it changed.
  const editsFile = readJsonBeside(dir, "edits.json");
  if (editsFile.absent) return refuse([`edits.json is missing from measures/derived/${id}/: a translation states its edits, [] for none`]);
  if ("problem" in editsFile) return refuse([editsFile.problem]);
  if (!Array.isArray(editsFile.json)) return refuse(["edits.json is not a JSON array"]);
  const editCount = editsFile.json.length;
  const changed = block.changedLibraries ?? [];
  if (changed.length > 0 && editCount === 0) {
    return refuse([`the manifest lists ${changed.length} changed librar${changed.length === 1 ? "y" : "ies"} but edits.json is [], so no edit case would run`]);
  }
  const expectedFile = readJsonBeside(dir, EXPECTED_DIFFERENCES_FILE);
  let expected: ExpectedDifference[] | undefined;
  if (!expectedFile.absent) {
    if ("problem" in expectedFile) return refuse([expectedFile.problem]);
    try {
      expected = parseExpectedDifferences(expectedFile.json);
    } catch (error) {
      return refuse([`${EXPECTED_DIFFERENCES_FILE}: ${error instanceof Error ? error.message : String(error)}`]);
    }
  }
  const editCasesFile = readJsonBeside(dir, EDIT_CASES_FILE);
  if (editCount === 0 && !editCasesFile.absent) {
    return refuse([`${EDIT_CASES_FILE} is present but edits.json is []: with no logic edit there is nothing for an edit case to tell apart`]);
  }
  if (editCount > 0 && editCasesFile.absent) {
    return refuse([`${EDIT_CASES_FILE} is missing: edits.json holds ${editCount} edit(s), and only an edit case shows the edit doing what it claims`]);
  }

  const contentDir = resolve(deps.cwd, args.contentDir);
  deps.verifyUpstream(contentDir, measure);
  const loaded = deps.loadCases(contentDir, measure);
  const cmsMain = mainLibraryName(loaded.measureBundle);
  const ourMain = mainLibraryName(derived.bundle);

  let editSet: EditCaseSet | undefined;
  if (editCount > 0 && !editCasesFile.absent) {
    if ("problem" in editCasesFile) return refuse([editCasesFile.problem]);
    try {
      editSet = parseEditCases(editCasesFile.json, declaredPopulations(loaded.measureBundle));
    } catch (error) {
      return refuse([`${EDIT_CASES_FILE}: ${error instanceof Error ? error.message : String(error)}`]);
    }
    const setProblems = editCaseSetProblems(editSet, loaded.measurementPeriod);
    if (setProblems.length > 0) return refuse(setProblems.map((p) => `edit cases: ${p}`));
  }

  // Every bundle is assembled — every carried shared library proven to be upstream's, every changed
  // library's edited defines found — before fqm runs at all, so a refusal costs nothing.
  const translated = translatedUpstreamBundle(loaded.measureBundle, derived.bundle, block);
  const translatedBroken = translatedUpstreamBundle(loaded.measureBundle, withInitialPopulationBroken(derived.bundle), block);
  const changedBreaks = changed.map((library) => {
    const { bundle, broken, differing } = withChangedLibraryBroken(derived.bundle, loaded.measureBundle, library);
    return { library, broken, differing, bundle: broken.length > 0 ? translatedUpstreamBundle(loaded.measureBundle, bundle, block) : undefined };
  });
  const runOn = async (bundle: FhirBundle) => {
    const captured: { output?: FqmOutput } = {};
    const run: OfficialMeasureRun = await deps.runCases({ ...loaded, measureBundle: bundle }, { onOutput: (o) => (captured.output = o) });
    renameLibrary(captured.output, ourMain, cmsMain);
    for (const library of changed) renameLibrary(captured.output, library.name, library.from.name);
    return { run, output: captured.output };
  };
  const captured: { output?: FqmOutput } = {};
  const upstreamRun = await deps.runCases(loaded, { onOutput: (o) => (captured.output = o) });
  const upstream = { run: upstreamRun, output: captured.output };
  const ours = await runOn(translated);
  const c = compareRuns(measure, upstream, ours);

  // ---- status, rates and strata: strict; define values: exactly the listed differences --------------
  const problems: string[] = [];
  const required = deps.requiredCases[id] ?? 0;
  if (c.cases === 0 || c.cases < required) problems.push(`deck has ${c.cases} cases, at least ${Math.max(required, 1)} required`);
  if (upstream.run.calculationError || ours.run.calculationError) problems.push(`calculation error: ${upstream.run.calculationError ?? ours.run.calculationError}`);
  if (c.compiled.errors > 0) problems.push(`${c.compiled.errors} case error(s) on the translation`);
  if (upstream.run.trustMetaProfile !== ours.run.trustMetaProfile) problems.push("the profile retry ran on one side only");
  for (const [label, count] of [["status", c.statusEqual], ["rates", c.ratesEqual], ["stratifiers", c.stratifiersEqual]] as const) {
    if (count !== c.cases) problems.push(`${label} differ on ${c.cases - count} case(s)`);
  }
  const { missing, unexpected } = matchExpectedDifferences(c.statementDifferences, expected ?? []);
  if (expected === undefined) {
    if (unexpected.length > 0) problems.push(`${unexpected.length} define value(s) differ, and no ${EXPECTED_DIFFERENCES_FILE} lists any`);
  } else {
    if (unexpected.length > 0) problems.push(`${unexpected.length} define value(s) differ that ${EXPECTED_DIFFERENCES_FILE} does not list`);
    if (missing.length > 0) problems.push(`${missing.length} difference(s) ${EXPECTED_DIFFERENCES_FILE} lists were not observed`);
  }
  const pinned = deps.pinnedStatements[id] ?? Number.POSITIVE_INFINITY;
  if (c.statementsCompared < pinned) problems.push(`compared ${c.statementsCompared} define values, at least ${pinned} required`);
  const listed = expected === undefined ? "" : ` · listed differences ${expected.length - missing.length}/${expected.length} observed, ${unexpected.length} unlisted`;
  deps.log(
    `${id}: madie ${c.cases} cases · status ${c.statusEqual} · rates ${c.ratesEqual} · stratifiers ${c.stratifiersEqual} · ` +
      `define values ${c.statementsCompared - c.statementsDiffering}/${c.statementsCompared} equal${listed} — ${problems.length ? "FAIL" : "PASS"} (reported, never recorded)`,
  );
  for (const [label, list] of [["unlisted difference", unexpected], ["listed difference not observed", missing]] as const) {
    for (const d of list.slice(0, PRINTED_DIFFERENCES)) deps.log(`  ${label}: ${describeDifference(d)}`);
    if (list.length > PRINTED_DIFFERENCES) deps.log(`  … and ${list.length - PRINTED_DIFFERENCES} more ${label}(s)`);
  }

  // ---- the breaks: each must move results, or the run above was not executing what it claims --------
  // "Initial Population" false: the main library is the translation's (a bundle that quietly kept CMS's
  // ELM passes all of the above).
  const broken = await runOn(translatedBroken);
  const brokenComparison = compareRuns(measure, upstream, broken);
  const moved = brokenComparison.cases - brokenComparison.ratesEqual;
  deps.log(`${id}: madie non-vacuity, "Initial Population" forced false → ${moved} case(s) move ${moved > 0 ? "(the check runs the translation)" : "— FAIL"}`);
  if (moved === 0) problems.push("breaking the translation moved no case: the check is not running the translation");

  // Each changed library's edited defines forced null: WorkWell's copy is the one that runs. Measured
  // against the UNBROKEN translation run, so every value that moves moved because of the break.
  for (const { library, broken: brokenDefs, differing, bundle } of changedBreaks) {
    const what = `${library.name} (WorkWell's edit of ${library.from.name} ${library.from.version})`;
    if (differing.length === 0) {
      problems.push(`${what} differs from CMS's copy in no define: an edit that changed nothing`);
      deps.log(`${id}: madie non-vacuity, ${what}: no define differs from CMS's — FAIL`);
      continue;
    }
    if (!bundle) {
      problems.push(`${what} only removes define(s) CMS's copy has (${differing.map((d) => d.key).join("; ")}), so there is nothing of WorkWell's to break`);
      deps.log(`${id}: madie non-vacuity, ${what}: nothing to break — FAIL`);
      continue;
    }
    const run = await runOn(bundle);
    const versus = compareRuns(measure, ours, run);
    const names = new Set(differing.filter((d) => d.in !== "cms").map((d) => `${library.from.name}.${d.name}`));
    const own = versus.statementDifferences.filter((d) => names.has(d.key.slice(d.key.indexOf("|") + 1))).length;
    deps.log(
      `${id}: madie non-vacuity, ${what}: ${brokenDefs.length} edited def(s) forced null (${brokenDefs.join("; ")}) → ` +
        `${versus.statementsDiffering} define value(s) move, ${own} of them the edited define(s) ${versus.statementsDiffering > 0 ? "(the check runs WorkWell's copy)" : "— FAIL"}`,
    );
    if (versus.statementsDiffering === 0) problems.push(`breaking ${what} moved no define value: the check is not running WorkWell's copy`);
  }

  // ---- edit cases: the patients that tell the two logics apart --------------------------------------
  if (editSet) {
    const outcome = await runEditCases({ set: editSet, loaded, upstreamBundle: loaded.measureBundle, translatedBundle: translated, runCases: deps.runCases });
    const agreeing = (side: "cms" | "translation") => outcome.sides.find((s) => s.side === side)?.agreeing ?? 0;
    deps.log(`${id}: edit cases: ${outcome.discriminating} of ${outcome.total} expect a different answer from the translation than from CMS's logic · period ${editSet.measurementPeriod.start}..${editSet.measurementPeriod.end}`);
    for (const side of outcome.sides) for (const line of side.disagreements) deps.log(`  ${line}`);
    deps.log(
      `${id}: edit cases ${outcome.total} · CMS's logic ${agreeing("cms")}/${outcome.total} · translation ${agreeing("translation")}/${outcome.total} — ` +
        `${outcome.problems.length ? "FAIL" : "PASS"}`,
    );
    problems.push(...outcome.problems.map((p) => `edit cases: ${p}`));
  }
  return problems.map((p) => `madie: ${p}`);
}

/**
 * Write the two records into the manifest, replacing any of the same name. Key order, 2-space indent and
 * the trailing newline are preserved, so the diff is the records alone. The bytes the run was checked
 * against are re-hashed first: a bundle or sidecar rewritten while the check ran must not be vouched for.
 */
function recordOracles(dir: string, records: readonly Oracle[], bundleSha: string, terminologySha: string): void {
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256?: string; terminology?: { file?: string; sha256?: string }; derived?: { oracles?: Oracle[] } };
  const terminologyFile = manifest.terminology?.file ?? "terminology.json";
  if (sha256OfFile(join(dir, "bundle.json"), "bundle.json") !== bundleSha || sha256OfFile(join(dir, terminologyFile), terminologyFile) !== terminologySha) {
    throw new Refusal("the translation's files changed on disk while the check ran");
  }
  if (manifest.sha256 !== bundleSha || manifest.terminology?.sha256 !== terminologySha) {
    throw new Refusal("manifest.json on disk no longer pins the files the check ran against");
  }
  if (!manifest.derived) throw new Refusal("manifest.json on disk has no derived block");
  const oracles = Array.isArray(manifest.derived.oracles) ? manifest.derived.oracles : [];
  for (const record of records) {
    const at = oracles.findIndex((o) => o.name === record.name);
    if (at >= 0) oracles[at] = record;
    else oracles.push(record);
  }
  manifest.derived.oracles = oracles;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
