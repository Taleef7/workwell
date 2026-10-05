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
 *                            gives CMS's answer on every case and every define value. Credential-free;
 *                            reported, never recorded.
 *
 * Each record names the exact bundle and sidecar it ran against, hashed from the bytes ON DISK — never
 * copied from the manifest — so a record cannot vouch for an artifact it did not run.
 *
 * Prints counts and hashes only: never a code, never a patient name. Exit 0 pass, 1 any failure or
 * refusal (nothing is written), 2 usage. DB-less; fqm runs in a worker thread (deck) or through
 * `standards/official-cases.ts` (MADiE), never imported here.
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
import { breakInitialPopulation, compareRuns, COMPILED_GATE_MEASURES, PINNED_STATEMENT_RESULTS, verifyUpstreamBundle, type CompiledGateMeasure } from "./compiled-cases.ts";
import { withCompiledElm, type CompiledLibrary } from "../../standards/qicore-compile.ts";
import { compareSidecarToCypressCsv, CSV_SYSTEM_FOR_OID } from "../../standards/terminology-equivalence.ts";
import { REQUIRED_OFFICIAL_CASE_COUNTS } from "./official-cases.ts";
import { createFqmWorker, type FqmWorker } from "../../wiring/fqm-worker.ts";
import {
  artifactKind,
  loadDerivedArtifact,
  loadOfficialArtifact,
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
  /** The directory holding `<catalogId>/{bundle.json,manifest.json,terminology.json}`. */
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
 * The bundle the MADiE comparison runs the translation as: the translation's Measure and MAIN library,
 * CMS's upstream copy of every shared library the translation carries, and everything else upstream ships
 * (its ValueSets above all). That is what makes the comparison about LOGIC: both runs see CMS's own 2026
 * terminology, so any difference is the main library's ELM.
 *
 * Why upstream's shared libraries rather than the translation's: the translation carries CMS's COMMITTED
 * copies, which (like every vendored artifact) have no `localId`, and without one fqm reports no value and
 * a different label for every define — measured, 2346 of 2970 differing on cms137 with the logic
 * untouched. So each carried library is first proven to BE upstream's — its ELM byte-equal once
 * `annotation`, `locator` and `localId` are stripped from both — and only then is upstream's own copy,
 * localIds included, run in its place. A carried library that differs, or that upstream lacks, is refused
 * by name: running upstream's copy would silently score logic the translation does not contain.
 */
export function translatedUpstreamBundle(upstream: FhirBundle, translation: Bundle): FhirBundle {
  const asLike = translation as unknown as { entry?: Array<{ resource?: Record<string, unknown> }> };
  const main = mainLibraryName(asLike);
  const key = (r: Record<string, unknown>) => `${String(r["name"])}|${String(r["version"])}`;
  const upstreamLibraries = new Map(upstream.entry.filter((e) => e.resource.resourceType === "Library").map((e) => [key(e.resource), e]));
  const ours: FhirBundle["entry"] = [];
  for (const entry of JSON.parse(JSON.stringify(translation.entry)) as FhirBundle["entry"]) {
    const resource = entry.resource;
    if (resource.resourceType === "Measure" || (resource.resourceType === "Library" && resource["name"] === main)) {
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
 * The translation renames its main library, so fqm reports every main-library define under the new name
 * and the per-statement comparison would see two disjoint sets. Renamed back IN PLACE — a JSON copy would
 * turn every cql-execution value into a plain object and make `canonicalValue` call them all different.
 */
function renameLibrary(output: FqmOutput | undefined, from: string, to: string): void {
  if (from === to) return;
  for (const result of output?.results ?? []) {
    for (const detail of (result.detailedResults ?? []) as Array<{ statementResults?: Array<{ libraryName?: string }> }>) {
      for (const statement of detail.statementResults ?? []) if (statement.libraryName === from) statement.libraryName = to;
    }
  }
}

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
      const required = new Set(requiredOids(derived));
      if (files === 0) failures.push(`--package-cql-dir holds no .cql files, so no declaration was checked`);
      const undeclared = [...declared].filter((oid) => !required.has(oid)).sort();
      const notInPackage = [...required].filter((oid) => !declared.has(oid)).sort();
      log(`${id}: package declarations: ${declared.size} value set(s) in ${files} .cql file(s); the translation declares ${required.size}`);
      if (undeclared.length) failures.push(`the package declares ${undeclared.length} value set(s) the translation does not: ${undeclared.join(", ")}`);
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
  if (args.madie) failures.push(...(await madie(args, deps, derived)));

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

async function madie(args: DerivedCheckArgs, deps: DerivedCheckDeps, derived: OfficialArtifact): Promise<string[]> {
  const id = args.catalogId;
  if (!(COMPILED_GATE_MEASURES as readonly string[]).includes(id)) return [`madie: ${id} has no pinned MADiE define count`];
  const measure = id as CompiledGateMeasure;
  const contentDir = resolve(deps.cwd, args.contentDir);
  deps.verifyUpstream(contentDir, measure);
  const loaded = deps.loadCases(contentDir, measure);
  const cmsMain = mainLibraryName(loaded.measureBundle);
  const ourMain = mainLibraryName(derived.bundle);

  // Both bundles are assembled — and every carried shared library proven to be upstream's — before fqm
  // runs at all, so a refusal costs nothing.
  const translated = translatedUpstreamBundle(loaded.measureBundle, derived.bundle);
  const translatedBroken = translatedUpstreamBundle(loaded.measureBundle, withInitialPopulationBroken(derived.bundle));
  const runOn = async (bundle: FhirBundle) => {
    const captured: { output?: FqmOutput } = {};
    const run: OfficialMeasureRun = await deps.runCases({ ...loaded, measureBundle: bundle }, { onOutput: (o) => (captured.output = o) });
    renameLibrary(captured.output, ourMain, cmsMain);
    return { run, output: captured.output };
  };
  const captured: { output?: FqmOutput } = {};
  const upstreamRun = await deps.runCases(loaded, { onOutput: (o) => (captured.output = o) });
  const upstream = { run: upstreamRun, output: captured.output };
  const ours = await runOn(translated);
  const c = compareRuns(measure, upstream, ours);

  const problems: string[] = [];
  const required = deps.requiredCases[id] ?? 0;
  if (c.cases === 0 || c.cases < required) problems.push(`deck has ${c.cases} cases, at least ${Math.max(required, 1)} required`);
  if (upstream.run.calculationError || ours.run.calculationError) problems.push(`calculation error: ${upstream.run.calculationError ?? ours.run.calculationError}`);
  if (c.compiled.errors > 0) problems.push(`${c.compiled.errors} case error(s) on the translation`);
  if (upstream.run.trustMetaProfile !== ours.run.trustMetaProfile) problems.push("the profile retry ran on one side only");
  for (const [label, count] of [["status", c.statusEqual], ["rates", c.ratesEqual], ["stratifiers", c.stratifiersEqual]] as const) {
    if (count !== c.cases) problems.push(`${label} differ on ${c.cases - count} case(s)`);
  }
  if (c.statementsDiffering > 0) problems.push(`${c.statementsDiffering} define value(s) differ`);
  const pinned = deps.pinnedStatements[id] ?? Number.POSITIVE_INFINITY;
  if (c.statementsCompared < pinned) problems.push(`compared ${c.statementsCompared} define values, at least ${pinned} required`);
  deps.log(
    `${id}: madie ${c.cases} cases · status ${c.statusEqual} · rates ${c.ratesEqual} · stratifiers ${c.stratifiersEqual} · ` +
      `define values ${c.statementsCompared - c.statementsDiffering}/${c.statementsCompared} equal — ${problems.length ? "FAIL" : "PASS"} (reported, never recorded)`,
  );

  // The break: the same comparison on a translation whose "Initial Population" is false must move cases,
  // or the run above was not executing the translation (a bundle that quietly kept CMS's ELM passes all).
  const broken = await runOn(translatedBroken);
  const brokenComparison = compareRuns(measure, upstream, broken);
  const moved = brokenComparison.cases - brokenComparison.ratesEqual;
  deps.log(`${id}: madie non-vacuity, "Initial Population" forced false → ${moved} case(s) move ${moved > 0 ? "(the check runs the translation)" : "— FAIL"}`);
  if (moved === 0) problems.push("breaking the translation moved no case: the check is not running the translation");
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
