/**
 * `pnpm build:derived` — build a WorkWell translation (decision 3, C3a) into `measures/derived/<id>/`,
 * or `--verify` that the committed one is exactly what its inputs rebuild.
 *
 *   pnpm build:derived --catalog-id cms137 --year 2027 --derived-from CMS137v15 --edits <edits.json> \
 *     --package <CMS's eCQM package zip> --vsac-manifest http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14
 *
 * The steps, each a refusal on failure: CMS's upstream bundle is the one the official manifest pins →
 * its main library, and every library an edit names, was compiled with the options we reproduce →
 * WorkWell's edits, grouped by library, land on the exact CMS lines they were written against, name only
 * libraries the upstream bundle holds, and change each library they name → the translator compiles the
 * library set TWICE, and the main library and every edited one compile to byte-identical ELM both times
 * (a build that is not reproducible cannot be verified later) → each of those reads exactly the data
 * CMS's committed ELM for it reads (`elmDataSurface`: the translation carries CMS's computed data
 * requirements, which are true only while no retrieve moved) → the main library's ELM is stripped of
 * CMS's CQL text and dropped into CMS's committed bundle, every edited shared library is dropped in the
 * same way under WorkWell's name with the main library's include repointed at it (a library that a
 * library other than the main one includes is refused), and every other shared library is carried
 * byte-for-byte → the translation's identity passes the same check the router runs → only then is
 * anything written. Output is counts and hashes; no CQL is ever printed.
 *
 * BUILD-ONLY: run by an operator once per edit, never by the worker. Exit 0 ok, 1 refused, 2 usage.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  assembleTranslationBundle,
  derivedManifestFor,
  groupEditsByLibrary,
  parseEdits,
  stripElmDebugKeys,
  translationIdentity,
  type ChangedLibraryBuild,
} from "../../standards/derived-build.ts";
import { cqlSha256 } from "../../standards/derived-changed-library.ts";
import { derivedIdentityProblems, installedTranslatorVersion, translatorId } from "../../standards/derived-identity.ts";
import { dataSurfaceDifferences, elmDataSurface } from "../../standards/elm-data-surface.ts";
import { loadOfficialMeasureCases, officialMeasureName, type LoadedOfficialMeasure, type OfficialMeasureId } from "../../standards/official-cases.ts";
import {
  assertAppliedOptions,
  assertCmsTranslatorOptions,
  bundleLibraries,
  compileLibrarySet,
  loadQiCoreModelInfos,
  QICORE_MODEL_INFO,
  type CompiledLibrary,
  type CompileOptions,
  type LibrarySource,
  type ModelInfoFile,
  type SignatureLevel,
} from "../../standards/qicore-compile.ts";
import { loadOfficialArtifact, type OfficialArtifact, type OfficialManifest } from "../../wiring/official-artifacts.ts";
import { verifyUpstreamBundle } from "./compiled-cases.ts";

const BACKEND_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DERIVED_ROOT = join(BACKEND_ROOT, "measures", "derived");

export const USAGE =
  "Usage: pnpm build:derived --catalog-id <id> --year <yyyy> --derived-from <e.g. CMS137v15> --edits <path>" +
  " --package <CMS package zip> --vsac-manifest <canonical> [--revision <n>] [--content-dir <path>]" +
  " [--signature-level All|Overloads] [--output-dir <dir>] [--verify] [--skip-terminology]";

export class BuildDerivedUsageError extends Error {
  override readonly name = "BuildDerivedUsageError";
}

export interface BuildDerivedArgs {
  catalogId: OfficialMeasureId;
  year: number;
  derivedFrom: string;
  edits: string;
  package?: string;
  vsacManifest?: string;
  revision: number;
  contentDir?: string;
  signatureLevel: SignatureLevel;
  outputDir?: string;
  verify: boolean;
  skipTerminology: boolean;
}

export function parseArgs(argv: string[]): BuildDerivedArgs {
  const values = new Map<string, string>();
  let verify = false;
  let skipTerminology = false;
  const VALUED = new Set(["--catalog-id", "--year", "--derived-from", "--edits", "--package", "--vsac-manifest", "--revision", "--content-dir", "--signature-level", "--output-dir"]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--verify") verify = true;
    else if (arg === "--skip-terminology") skipTerminology = true;
    else if (arg === "--help" || arg === "-h") throw new BuildDerivedUsageError(USAGE);
    else if (VALUED.has(arg)) {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new BuildDerivedUsageError(`${arg} needs a value\n${USAGE}`);
      values.set(arg, next);
    } else {
      throw new BuildDerivedUsageError(`unknown argument '${arg}'\n${USAGE}`);
    }
  }
  const required = (flag: string, why = ""): string => {
    const value = values.get(flag);
    if (!value) throw new BuildDerivedUsageError(`${flag} is required${why}\n${USAGE}`);
    return value;
  };
  const catalogId = required("--catalog-id");
  if (!officialMeasureName(catalogId)) throw new BuildDerivedUsageError(`--catalog-id '${catalogId}' has no official content to translate\n${USAGE}`);
  const year = required("--year");
  if (!/^\d{4}$/.test(year)) throw new BuildDerivedUsageError(`--year must be a four-digit year\n${USAGE}`);
  const derivedFrom = required("--derived-from");
  // "No edits" must be said, as an explicit [] file: a forgotten flag must not build CMS's logic under a
  // WorkWell name for a year it was never written for.
  const edits = required("--edits", " (an explicit [] file means no edits)");
  const pkg = values.get("--package");
  if (!pkg && !verify) throw new BuildDerivedUsageError(`--package is required (the CMS package the edits were read from; optional only with --verify)\n${USAGE}`);
  const vsacManifest = values.get("--vsac-manifest");
  if (!vsacManifest && !skipTerminology) throw new BuildDerivedUsageError(`--vsac-manifest is required unless --skip-terminology\n${USAGE}`);
  const revisionText = values.get("--revision") ?? "1";
  if (!/^[1-9]\d*$/.test(revisionText)) throw new BuildDerivedUsageError(`--revision must be a positive integer\n${USAGE}`);
  const level = values.get("--signature-level") ?? "All";
  if (level !== "All" && level !== "Overloads") throw new BuildDerivedUsageError(`--signature-level must be All or Overloads\n${USAGE}`);
  return {
    catalogId: catalogId as OfficialMeasureId,
    year: Number(year),
    derivedFrom,
    edits,
    ...(pkg ? { package: pkg } : {}),
    ...(vsacManifest ? { vsacManifest } : {}),
    revision: Number(revisionText),
    ...(values.get("--content-dir") ? { contentDir: values.get("--content-dir")! } : {}),
    signatureLevel: level,
    ...(values.get("--output-dir") ? { outputDir: values.get("--output-dir")! } : {}),
    verify,
    skipTerminology,
  };
}

/** What `scripts/vendor-derived-terminology.mjs --emit-block` is asked for. */
export interface TerminologyEmitRequest {
  catalogId: string;
  vsacManifest: string;
  /** CMS's official sidecar, relative to the backend root (it supplies only each set's prior count). */
  baseTerminology: string;
  /** Where the script reads `bundle.json` from and writes the sidecar to. */
  outputDir: string;
}

export interface BuildDerivedFs {
  readFile: (path: string) => Buffer;
  writeFile: (path: string, data: string | Buffer) => void;
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
  mkdtemp: (prefix: string) => string;
  rm: (path: string) => void;
}

export interface BuildDerivedDeps {
  cwd: string;
  verifyUpstream: (contentDir: string, measure: OfficialMeasureId) => void;
  load: (contentDir: string, measure: OfficialMeasureId) => Pick<LoadedOfficialMeasure, "measureBundle">;
  loadBase: (catalogId: string) => OfficialArtifact | null;
  compile: (sources: readonly LibrarySource[], options: CompileOptions) => CompiledLibrary[];
  modelInfos: () => ModelInfoFile[];
  installedTranslatorVersion: () => string;
  /** Returns the script's stdout, which must be exactly one JSON document: the manifest's terminology block. */
  runTerminologyEmit: (request: TerminologyEmitRequest) => string;
  fs: BuildDerivedFs;
  log: (message: string) => void;
  error: (message: string) => void;
}

export function defaultBuildDerivedDeps(): BuildDerivedDeps {
  return {
    cwd: process.cwd(),
    verifyUpstream: verifyUpstreamBundle,
    load: loadOfficialMeasureCases,
    loadBase: loadOfficialArtifact,
    compile: compileLibrarySet,
    modelInfos: () => loadQiCoreModelInfos(),
    installedTranslatorVersion,
    runTerminologyEmit: (request) =>
      execFileSync(
        process.execPath,
        [
          join(BACKEND_ROOT, "scripts", "vendor-derived-terminology.mjs"),
          "--catalog-id", request.catalogId,
          "--emit-block",
          "--base-terminology", request.baseTerminology,
          "--vsac-manifest", request.vsacManifest,
          "--output-dir", request.outputDir,
        ],
        // stderr is the script's progress, shown as it runs; stdout is the block, captured whole.
        { cwd: BACKEND_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
      ),
    fs: {
      readFile: (path) => readFileSync(path),
      writeFile: (path, data) => writeFileSync(path, data),
      exists: existsSync,
      mkdir: (path) => mkdirSync(path, { recursive: true }),
      mkdtemp: (prefix) => mkdtempSync(prefix),
      rm: (path) => rmSync(path, { recursive: true, force: true }),
    },
    log: console.log,
    error: console.error,
  };
}

const sha256 = (data: string | Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

type TerminologyBlock = NonNullable<OfficialManifest["terminology"]>;

function parseTerminologyBlock(stdout: string): TerminologyBlock {
  let block: unknown;
  try {
    block = JSON.parse(stdout);
  } catch {
    throw new Error("the terminology emit's stdout is not one JSON document (it must print the manifest block and nothing else)");
  }
  const b = block as Partial<TerminologyBlock> | null;
  if (!b || typeof b !== "object" || typeof b.file !== "string" || typeof b.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(b.sha256)) {
    throw new Error("the terminology emit printed JSON that is not a manifest terminology block (file and sha256 are required)");
  }
  if (!b.completion?.manifest) throw new Error("the terminology block names no VSAC release (completion.manifest)");
  return b as TerminologyBlock;
}

interface Built {
  bundleJson: string;
  manifest: OfficialManifest;
  warnings: string[];
  /** The sidecar the emit wrote, to be copied beside the bundle; absent with --skip-terminology. */
  sidecar?: { file: string; bytes: Buffer };
}

export async function main(argv: string[], overrides: Partial<BuildDerivedDeps> = {}): Promise<number> {
  const deps = { ...defaultBuildDerivedDeps(), ...overrides };
  let args: BuildDerivedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    return run(args, deps);
  } catch (error) {
    deps.error(`build:derived ${args.catalogId}: REFUSED — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function run(args: BuildDerivedArgs, deps: BuildDerivedDeps): number {
  const id = args.catalogId;
  const cwd = deps.cwd;
  const identity = translationIdentity(id, args.year, args.derivedFrom, args.revision);
  const contentDir = resolve(cwd, args.contentDir ?? ".official-content");
  const outputDir = args.outputDir ? resolve(cwd, args.outputDir) : join(DERIVED_ROOT, id);
  const manifestPath = join(outputDir, "manifest.json");
  const previous = deps.fs.exists(manifestPath) ? (JSON.parse(deps.fs.readFile(manifestPath).toString("utf8")) as OfficialManifest) : null;
  if (args.verify && !previous) throw new Error(`nothing is committed at ${outputDir} to verify against`);

  let editsJson: unknown;
  try {
    editsJson = JSON.parse(deps.fs.readFile(resolve(cwd, args.edits)).toString("utf8"));
  } catch (error) {
    throw new Error(`cannot read the edits file ${args.edits}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const edits = parseEdits(editsJson);
  const packageSha256 = args.package
    ? sha256(deps.fs.readFile(resolve(cwd, args.package)))
    : (previous?.derived?.derivedFrom.packageSha256 ?? "");

  // CMS's CQL, from exactly the upstream file the official artifact was vendored from.
  deps.verifyUpstream(contentDir, id);
  const upstream = deps.load(contentDir, id).measureBundle as { entry?: Array<{ resource?: Record<string, unknown> }> };
  const libraries = bundleLibraries(upstream);
  const upstreamMeasure = (upstream.entry ?? []).map((e) => e.resource).find((r) => r?.["resourceType"] === "Measure");
  const mainUrl = ((upstreamMeasure?.["library"] as string[] | undefined) ?? [])[0];
  const main = libraries.find((l) => l.resource["url"] === mainUrl || `${String(l.resource["url"])}|${l.version}` === mainUrl);
  if (!main) throw new Error(`the upstream Measure's library '${String(mainUrl)}' names no library in the upstream bundle`);
  assertCmsTranslatorOptions(main.resource as { name?: string; contained?: unknown[] });

  // Edits are grouped by the library they name (line numbers mean something only within one library).
  // A shared library WorkWell edits becomes a CHANGED library: compiled from the edited text under CMS's
  // name, then given WorkWell's identity, with the main library's include repointed at it (#779).
  const editsByLibrary = groupEditsByLibrary(edits);
  const absent = [...editsByLibrary.keys()].filter((name) => !libraries.some((l) => l.name === name));
  if (absent.length > 0) {
    throw new Error(`the edits name ${absent.join(", ")}, which the upstream bundle does not hold (it holds ${libraries.map((l) => l.name).join(", ")})`);
  }
  const editedCql = new Map<string, string>();
  for (const library of libraries) {
    const libraryEdits = editsByLibrary.get(library.name);
    if (!libraryEdits) continue;
    // Checked on every library an edit names, not only the main one: the edited text is compiled with
    // these options and its ELM compared with CMS's, which is meaningful only if CMS compiled it with them.
    if (library !== main) assertCmsTranslatorOptions(library.resource as { name?: string; contained?: unknown[] });
    const cql = applyEdits(library.cql, libraryEdits);
    // An edit that changes nothing would put WorkWell's name on CMS's untouched library.
    if (lf(cql) === lf(library.cql)) {
      throw new Error(`the edits to ${library.name} ${library.version} leave its CQL byte-equal to CMS's; an edit must change the library it names`);
    }
    editedCql.set(library.name, cql);
  }
  const changed = libraries.filter((l) => l !== main && editedCql.has(l.name));
  const translationSha256 = sha256(lf(editedCql.get(main.name) ?? main.cql));
  deps.log(`${id}: ${editsByLibrary.get(main.name)?.length ?? 0} edit(s) applied to ${main.name} ${main.version}; translated CQL ${translationSha256}`);
  for (const library of changed) {
    deps.log(`${id}: ${editsByLibrary.get(library.name)!.length} edit(s) applied to ${library.name} ${library.version}; translated CQL ${cqlSha256(editedCql.get(library.name)!)}`);
  }

  const sources: LibrarySource[] = libraries.map((l) => ({ name: l.name, version: l.version, cql: editedCql.get(l.name) ?? l.cql }));
  const modelInfos = deps.modelInfos();
  const compileAll = () => deps.compile(sources, { modelInfos, signatureLevel: args.signatureLevel });
  const compiledOf = (set: readonly CompiledLibrary[], library: { name: string; version: string }): CompiledLibrary => {
    const compiled = set.find((c) => c.name === library.name && c.version === library.version);
    if (!compiled) throw new Error(`the compile returned no ${library.name} ${library.version}`);
    return compiled;
  };
  const first = compileAll();
  const second = compileAll();
  // WorkWell's compile of the main library and of every edited one is what the bundle carries; each must
  // be reproducible and compiled with CMS's options. The unedited shared libraries are carried as CMS's.
  const ours = [main, ...changed];
  const elmSha256 = new Map<string, string>();
  for (const library of ours) {
    const firstJson = JSON.stringify(compiledOf(first, library).elm);
    const secondJson = JSON.stringify(compiledOf(second, library).elm);
    if (firstJson !== secondJson) {
      throw new Error(
        `the translator compiled ${library.name} to different ELM on two runs (${sha256(firstJson)} vs ${sha256(secondJson)}); ` +
          "a translation that is not reproducible byte for byte cannot be verified, so none is written",
      );
    }
    assertAppliedOptions(compiledOf(first, library).elm, args.signatureLevel, `${library.name} ${library.version}`);
    elmSha256.set(library.name, sha256(firstJson));
  }
  deps.log(
    `${id}: compiled ${sources.length} libraries twice; ${ours.map((l) => `${l.name} ELM identical on both (${elmSha256.get(l.name)})`).join(", ")}`,
  );

  const base = deps.loadBase(id);
  if (!base) throw new Error(`CMS's artifact measures/official/${id}/ is not committed`);
  const baseBundle = base.bundle as unknown as { entry?: Array<{ resource?: Record<string, unknown> }> };
  assertSameDataSurface(baseBundle, ours, (library) => compiledOf(first, library).elm);
  const { bundle, unchangedLibraries, changedLibraries } = assembleTranslationBundle(
    baseBundle,
    stripElmDebugKeys(compiledOf(first, main).elm),
    identity,
    changed.map(
      (library): ChangedLibraryBuild => ({
        from: { name: library.name, version: library.version },
        compiledElm: compiledOf(first, library).elm,
        translationSha256: cqlSha256(editedCql.get(library.name)!),
      }),
    ),
  );
  const bundleJson = `${JSON.stringify(bundle, null, 0)}\n`;

  const built = withTerminology(args, deps, previous, bundleJson, (terminologyBlock) =>
    derivedManifestFor({
      base,
      bundleJson,
      identity,
      build: {
        translator: translatorId(deps.installedTranslatorVersion()),
        modelInfoSha256: `sha256:${QICORE_MODEL_INFO.sha256}`,
        signatureLevel: args.signatureLevel,
        translationSha256,
      },
      unchangedLibraries,
      changedLibraries,
      packageSha256,
      terminologyBlock,
      previous,
    }),
  );
  for (const warning of built.warnings) deps.error(`${id}: WARNING ${warning}`);

  // The check the router runs, run here first: an artifact the router would refuse is never written.
  const identityProblems = derivedIdentityProblems(JSON.parse(bundleJson), built.manifest, base, { installedTranslatorVersion: deps.installedTranslatorVersion });
  if (identityProblems.length > 0) throw new Error(`the translation's identity would be refused:\n  ${identityProblems.join("\n  ")}`);
  deps.log(
    `${id}: ${identity.name} ${identity.version}: bundle.json ${built.manifest.sha256} (${Buffer.byteLength(bundleJson)} bytes), ` +
      `${unchangedLibraries.length} libraries carried unchanged, ${changedLibraries.length} changed` +
      `${changedLibraries.length > 0 ? ` (${changedLibraries.map((l) => `${l.name} ${l.version} from ${l.from.name} ${l.from.version}`).join(", ")})` : ""}, ` +
      `terminology ${built.manifest.terminology?.sha256} (${built.manifest.terminology?.valueSets} value sets, ${built.manifest.terminology?.codes} codes)`,
  );

  if (args.verify) return verifyAgainstCommitted(args, deps, outputDir, previous!, built);

  deps.fs.mkdir(outputDir);
  deps.fs.writeFile(join(outputDir, "bundle.json"), bundleJson);
  if (built.sidecar) deps.fs.writeFile(join(outputDir, built.sidecar.file), built.sidecar.bytes);
  // Last: the manifest is what makes the directory a translation, so it never describes files not yet written.
  deps.fs.writeFile(manifestPath, `${JSON.stringify(built.manifest, null, 2)}\n`);
  deps.log(`${id}: wrote ${outputDir} (${built.manifest.derived!.oracles.length} oracle record(s) carried)`);
  return 0;
}

/**
 * Refuse unless every library WorkWell compiled for the bundle (the main one and each edited one) reads
 * exactly the data CMS's committed ELM for the same library reads: the same value sets, codes and code
 * systems declared, and the same retrieves with multiplicity (`elmDataSurface`). The translation carries
 * CMS's computed data requirements — the Measure's `dataRequirement` entries and the `depends-on` value
 * sets, which MADiE computed from CMS's ELM — and nothing recomputes them, so they are true only while
 * this holds. An edit that changes how fetched data is compared (`starts during` → `overlaps`) passes;
 * one that fetches another value set or resource type does not, until the builder recomputes them.
 * Compared with CMS's COMMITTED ELM (what the translation is built on), not upstream's; calibrated equal
 * for an unedited recompile, see `elm-data-surface.ts`.
 */
function assertSameDataSurface(
  baseBundle: { entry?: Array<{ resource?: Record<string, unknown> }> },
  libraries: ReadonlyArray<{ name: string; version: string }>,
  oursOf: (library: { name: string; version: string }) => unknown,
): void {
  const baseLibraries = (baseBundle.entry ?? []).map((e) => e.resource).filter((r) => r?.["resourceType"] === "Library");
  for (const library of libraries) {
    const cms = baseLibraries.find((l) => l?.["name"] === library.name && l["version"] === library.version);
    const data = ((cms?.["content"] as Array<{ contentType?: string; data?: string }> | undefined) ?? []).find((c) => c.contentType === "application/elm+json")?.data;
    if (!data) throw new Error(`CMS's committed artifact holds no ELM for ${library.name} ${library.version} to compare the translation's data requirements with`);
    const differences = dataSurfaceDifferences(elmDataSurface(JSON.parse(Buffer.from(data, "base64").toString("utf8"))), elmDataSurface(oursOf(library)));
    if (differences.length > 0) {
      throw new Error(
        `${library.name} ${library.version} would read other data than CMS's, but the translation carries CMS's computed data ` +
          `requirements, which nothing recomputes:\n  ${differences.join("\n  ")}`,
      );
    }
  }
}

/**
 * The terminology block: from the committed manifest with --skip-terminology, otherwise from the emit
 * script, run in a scratch directory holding the new bundle.json (it reads the ELM there to learn which
 * value sets to expand). Nothing reaches the output directory from here; `run` copies the sidecar only
 * after every check has passed.
 */
function withTerminology(
  args: BuildDerivedArgs,
  deps: BuildDerivedDeps,
  previous: OfficialManifest | null,
  bundleJson: string,
  manifestFor: (block: TerminologyBlock) => { manifest: OfficialManifest; warnings: string[] },
): Built {
  if (args.skipTerminology) {
    const block = previous?.terminology;
    if (!block) throw new Error("--skip-terminology takes the terminology block from the committed manifest, and there is none");
    if (args.vsacManifest && block.completion?.manifest !== args.vsacManifest) {
      throw new Error(`--vsac-manifest names ${args.vsacManifest}, but the committed terminology was expanded at ${block.completion?.manifest ?? "no release"}`);
    }
    return { bundleJson, ...manifestFor(block) };
  }
  const scratch = deps.fs.mkdtemp(join(tmpdir(), `build-derived-${args.catalogId}-`));
  try {
    deps.fs.writeFile(join(scratch, "bundle.json"), bundleJson);
    const block = parseTerminologyBlock(
      deps.runTerminologyEmit({
        catalogId: args.catalogId,
        vsacManifest: args.vsacManifest!,
        baseTerminology: `measures/official/${args.catalogId}/terminology.json`,
        outputDir: scratch,
      }),
    );
    if (block.completion?.manifest !== args.vsacManifest) {
      throw new Error(`the terminology was expanded at ${block.completion?.manifest}, not the requested ${args.vsacManifest}`);
    }
    const sidecarPath = join(scratch, block.file);
    if (!deps.fs.exists(sidecarPath)) throw new Error(`the terminology emit wrote no ${block.file}`);
    const bytes = deps.fs.readFile(sidecarPath);
    // The block is committed and the sidecar is not, so the block's hash is the only thing that will ever
    // vouch for the sidecar; it must describe these exact bytes.
    if (sha256(bytes) !== block.sha256) throw new Error(`the emitted ${block.file} hashes to ${sha256(bytes)}, but its block says ${block.sha256}`);
    return { bundleJson, ...manifestFor(block), sidecar: { file: block.file, bytes } };
  } finally {
    deps.fs.rm(scratch);
  }
}

/**
 * Where two parsed manifests differ, as dotted key paths — never the values (a whole terminology block or
 * oracle list printed into a CI log helps nobody, and a path says exactly which field to look at). Objects
 * are descended; an array or a scalar that differs is reported at its own path. Equal data written in
 * another key order is reported as such, since the bytes are what is pinned.
 */
export function differingManifestPaths(was: unknown, now: unknown, path = ""): string[] {
  if (JSON.stringify(was) === JSON.stringify(now)) return [];
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObject(was) && isObject(now)) {
    const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])];
    const out = keys.flatMap((key) => differingManifestPaths(was[key], now[key], path ? `${path}.${key}` : key));
    return out.length > 0 ? out : [`${path || "(top level)"} (key order)`];
  }
  if (isDeepStrictEqual(was, now)) return [`${path || "(top level)"} (key order)`];
  return [path || "(the whole document)"];
}

function verifyAgainstCommitted(args: BuildDerivedArgs, deps: BuildDerivedDeps, outputDir: string, committed: OfficialManifest, built: Built): number {
  const id = args.catalogId;
  const differences: string[] = [];
  const bundlePath = join(outputDir, "bundle.json");
  if (!deps.fs.exists(bundlePath)) differences.push("bundle.json is not committed");
  else {
    const bytes = deps.fs.readFile(bundlePath);
    if (!bytes.equals(Buffer.from(built.bundleJson, "utf8"))) differences.push(`bundle.json: committed ${sha256(bytes)}, rebuilt ${built.manifest.sha256}`);
  }
  // The WHOLE manifest text, not a list of fields: a field left off a list is a field anyone can hand-edit
  // past the verify — `derived.label`, which every screen shows, was exactly that. Every field is
  // reproducible: the oracle records carry forward when the bundle and terminology hashes are unchanged,
  // the package hash comes from the committed manifest unless --package is given, and --skip-terminology
  // reuses the committed block. So a rebuild of an untouched translation is this text byte for byte, and
  // anything else is a difference to name. (A re-expansion must reproduce the committed block exactly.)
  const committedText = deps.fs.readFile(join(outputDir, "manifest.json")).toString("utf8");
  const rebuiltText = `${JSON.stringify(built.manifest, null, 2)}\n`;
  if (committedText !== rebuiltText) {
    const paths = differingManifestPaths(committed, built.manifest);
    differences.push(
      paths.length > 0
        ? `manifest.json differs from the rebuild at: ${paths.join(", ")}`
        : "manifest.json differs from the rebuild only in its formatting (indent, line endings or the trailing newline)",
    );
  }
  if (differences.length > 0) {
    deps.error(`${id}: --verify FAILED, the committed translation is not what its inputs rebuild:`);
    for (const difference of differences) deps.error(`  ${difference}`);
    return 1;
  }
  deps.log(`${id}: --verify ok — ${outputDir} is exactly what its inputs rebuild (nothing written)`);
  return 0;
}
