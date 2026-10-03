/**
 * The calibration gate for the QI-Core compile path: compile each pilot measure's libraries FROM CMS's
 * CQL with our translator (`standards/qicore-compile.ts`), run CMS's MADiE deck on our ELM and on CMS's
 * own, and require the two to agree on every case, every rate, every stratifier and every per-statement
 * result. A 2027 translation is only as trustworthy as the compiler that builds it; this is what shows
 * the compiler reproduces CMS's logic before any of it is changed.
 *
 * DB-less and diagnostic-only. fqm-execution is reached only through `standards/official-cases.ts`.
 * The comparison is CMS's ELM vs ours on CMS's own ValueSets, so no VSAC credential is needed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POPULATION_CODES,
  loadOfficialMeasureCases,
  runOfficialMeasureCases,
  type FqmCalculate,
  type LoadedOfficialMeasure,
  type OfficialMeasureId,
  type OfficialMeasureRun,
  type PopulationCounts,
} from "../../standards/official-cases.ts";
import {
  assertCmsTranslatorOptions,
  bundleLibraries,
  compileLibrarySet,
  loadQiCoreModelInfos,
  withCompiledElm,
  type CompiledLibrary,
  type ModelInfoFile,
  type SignatureLevel,
} from "../../standards/qicore-compile.ts";
import { REQUIRED_OFFICIAL_CASE_COUNTS } from "./official-cases.ts";

/** The six measures the pilot sandbox routes — the ones a 2027 translation would replace. */
export const COMPILED_GATE_MEASURES = ["cms122", "cms125", "cms130", "cms137", "cms165", "cms2"] as const satisfies readonly OfficialMeasureId[];
export type CompiledGateMeasure = (typeof COMPILED_GATE_MEASURES)[number];

/**
 * Per-statement results each deck must compare (statement × group × patient, from CMS's ELM run). A
 * pinned count, not a floor: if it moves, either the deck or what fqm reports changed, and the zero
 * differences below would no longer mean what they meant.
 */
export const PINNED_STATEMENT_RESULTS: Record<CompiledGateMeasure, number> = {
  cms122: 8250,
  cms125: 10164,
  cms130: 9856,
  cms137: 15390,
  cms165: 10676,
  cms2: 4572,
};

/** The measure whose "Initial Population" the non-vacuity check breaks: multi-rate, so both rates move. */
export const NON_VACUITY_MEASURE: CompiledGateMeasure = "cms137";

export const USAGE =
  `Usage: pnpm test:compiled-cases [--measure ${COMPILED_GATE_MEASURES.join("|")}]... [--content-dir <path>]` +
  ` [--signature-level All|Overloads] [--elm-out <dir>]`;

export class CompiledCasesUsageError extends Error {
  override readonly name = "CompiledCasesUsageError";
}

export interface CompiledCasesArgs {
  measures: CompiledGateMeasure[];
  contentDir?: string;
  signatureLevel: SignatureLevel;
  elmOut?: string;
}

export function parseArgs(argv: string[]): CompiledCasesArgs {
  const measures: CompiledGateMeasure[] = [];
  let contentDir: string | undefined;
  let signatureLevel: SignatureLevel = "All";
  let elmOut: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[++index];
      if (!next) throw new CompiledCasesUsageError(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--measure") {
      const id = value();
      if (!(COMPILED_GATE_MEASURES as readonly string[]).includes(id)) {
        throw new CompiledCasesUsageError(`--measure must be one of ${COMPILED_GATE_MEASURES.join("|")}\n${USAGE}`);
      }
      if (!measures.includes(id as CompiledGateMeasure)) measures.push(id as CompiledGateMeasure);
    } else if (arg === "--content-dir") {
      contentDir = value();
    } else if (arg === "--signature-level") {
      const level = value();
      if (level !== "All" && level !== "Overloads") throw new CompiledCasesUsageError(`--signature-level must be All or Overloads\n${USAGE}`);
      signatureLevel = level;
    } else if (arg === "--elm-out") {
      elmOut = value();
    } else if (arg === "--help" || arg === "-h") {
      throw new CompiledCasesUsageError(USAGE);
    } else {
      throw new CompiledCasesUsageError(`unknown argument '${arg}'\n${USAGE}`);
    }
  }
  return {
    measures: measures.length > 0 ? measures : [...COMPILED_GATE_MEASURES],
    ...(contentDir ? { contentDir } : {}),
    signatureLevel,
    ...(elmOut ? { elmOut } : {}),
  };
}

type FqmOutput = Awaited<ReturnType<FqmCalculate>>;

interface StatementResult {
  libraryName?: string;
  statementName?: string;
  final?: unknown;
  relevance?: unknown;
}
interface StratifierResult {
  strataId?: string;
  strataCode?: string;
  result?: unknown;
  appliesResult?: unknown;
}
interface DetailedResult {
  statementResults?: StatementResult[];
  stratifierResults?: StratifierResult[];
}

const ARTIFACT_ROOT = fileURLToPath(new URL("../../../measures/official/", import.meta.url));

/** Refuse an upstream bundle that is not the one each manifest pins — the comparison is only about THAT file. */
export function verifyUpstreamBundle(contentDir: string, measure: OfficialMeasureId, artifactRoot = ARTIFACT_ROOT): void {
  const manifest = JSON.parse(readFileSync(join(artifactRoot, measure, "manifest.json"), "utf8")) as {
    source: { path: string; rawSha256: string };
  };
  const path = join(contentDir, manifest.source.path);
  if (!existsSync(path)) throw new Error(`${measure}: upstream bundle ${path} is missing — run scripts/fetch-official-cases.ps1`);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  const expected = manifest.source.rawSha256.replace(/^sha256:/, "");
  if (actual !== expected) throw new Error(`${measure}: upstream bundle hashes to ${actual}, manifest pins ${expected}`);
}

const rateVector = (rates: PopulationCounts[] | undefined): string =>
  (rates ?? []).map((rate) => POPULATION_CODES.map((code) => rate[code]).join("")).join("|");

function statementsByPatient(output: FqmOutput | undefined): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const result of output?.results ?? []) {
    const statements = new Map<string, string>();
    ((result.detailedResults ?? []) as DetailedResult[]).forEach((detail, group) => {
      for (const s of detail.statementResults ?? []) {
        statements.set(`g${group}|${s.libraryName}.${s.statementName}`, `${JSON.stringify(s.final ?? null)}|${String(s.relevance ?? "")}`);
      }
    });
    out.set(String(result.patientId), statements);
  }
  return out;
}

function stratifiersByPatient(output: FqmOutput | undefined): Map<string, string> {
  return new Map(
    (output?.results ?? []).map((result) => [
      String(result.patientId),
      JSON.stringify(
        ((result.detailedResults ?? []) as DetailedResult[]).map((detail) =>
          (detail.stratifierResults ?? []).map((s) => [s.strataId ?? s.strataCode, s.result, s.appliesResult ?? null]),
        ),
      ),
    ]),
  );
}

export interface MeasureComparison {
  measure: CompiledGateMeasure;
  cases: number;
  /** Cases whose agreement status (vs the expected vectors) is the same on our ELM as on CMS's. */
  statusEqual: number;
  ratesEqual: number;
  stratifiersEqual: number;
  statementsCompared: number;
  statementsDiffering: number;
  samples: string[];
  defCountMismatches: string[];
  /** Defs whose structure (ignoring localId/locator/annotation) is identical to CMS's — informational. */
  structurallyIdentical: number;
  defs: number;
  upstream: OfficialMeasureRun["summary"];
  compiled: OfficialMeasureRun["summary"];
  problems: string[];
}

/** Compare a run on CMS's ELM with a run on ours, case by case and statement by statement. */
export function compareRuns(
  measure: CompiledGateMeasure,
  upstream: { run: OfficialMeasureRun; output: FqmOutput | undefined },
  compiled: { run: OfficialMeasureRun; output: FqmOutput | undefined },
): Omit<MeasureComparison, "defCountMismatches" | "structurallyIdentical" | "defs" | "problems"> {
  const upCases = new Map(upstream.run.cases.map((c) => [c.uuid, c]));
  const upStatements = statementsByPatient(upstream.output);
  const ourStatements = statementsByPatient(compiled.output);
  const upStrata = stratifiersByPatient(upstream.output);
  const ourStrata = stratifiersByPatient(compiled.output);
  const samples: string[] = [];
  let statusEqual = 0;
  let ratesEqual = 0;
  let stratifiersEqual = 0;
  let statementsCompared = 0;
  let statementsDiffering = 0;
  for (const ours of compiled.run.cases) {
    const theirs = upCases.get(ours.uuid);
    if (!theirs) {
      samples.push(`${ours.uuid}: not in the upstream run`);
      continue;
    }
    if ((ours.agreement?.status ?? ours.error ?? "none") === (theirs.agreement?.status ?? theirs.error ?? "none")) statusEqual++;
    else if (samples.length < 15) samples.push(`${ours.uuid}: status ${theirs.agreement?.status ?? theirs.error} vs ours ${ours.agreement?.status ?? ours.error}`);
    if (rateVector(ours.actualRates) === rateVector(theirs.actualRates) && rateVector(ours.actualRates) !== "") ratesEqual++;
    else if (samples.length < 15) samples.push(`${ours.uuid}: rates ${rateVector(theirs.actualRates)} vs ours ${rateVector(ours.actualRates)}`);
    const pid = String(ours.patientId);
    if (upStrata.get(pid) === ourStrata.get(pid)) stratifiersEqual++;
    const up = upStatements.get(pid) ?? new Map<string, string>();
    const ourMap = ourStatements.get(pid) ?? new Map<string, string>();
    for (const [key, value] of up) {
      statementsCompared++;
      if (ourMap.get(key) !== value) {
        statementsDiffering++;
        if (samples.length < 15) samples.push(`${ours.uuid} ${key}: ${value} vs ours ${ourMap.get(key)}`);
      }
    }
    for (const key of ourMap.keys()) {
      if (up.has(key)) continue;
      statementsDiffering++;
      if (samples.length < 15) samples.push(`${ours.uuid} ${key}: only in ours`);
    }
  }
  return {
    measure,
    cases: compiled.run.cases.length,
    statusEqual,
    ratesEqual,
    stratifiersEqual,
    statementsCompared,
    statementsDiffering,
    samples,
    upstream: upstream.run.summary,
    compiled: compiled.run.summary,
  };
}

const DROP = new Set(["localId", "locator", "annotation"]);
const canon = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(canon);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.keys(node)
        .filter((key) => !DROP.has(key))
        .sort()
        .map((key) => [key, canon((node as Record<string, unknown>)[key])]),
    );
  }
  return node;
};

interface ElmDef {
  name?: string;
}
const defsOf = (elm: unknown): ElmDef[] => ((elm as { library?: { statements?: { def?: ElmDef[] } } } | undefined)?.library?.statements?.def ?? []);

/** Def counts must match CMS's per library; structural equality is reported, never required. */
function structure(compiled: readonly CompiledLibrary[], upstream: ReadonlyMap<string, unknown>) {
  const defCountMismatches: string[] = [];
  let structurallyIdentical = 0;
  let defs = 0;
  for (const library of compiled) {
    const ours = defsOf(library.elm);
    const theirs = defsOf(upstream.get(library.name));
    if (ours.length !== theirs.length) defCountMismatches.push(`${library.name}: ${ours.length} defs vs CMS's ${theirs.length}`);
    defs += theirs.length;
    theirs.forEach((def, i) => {
      if (ours[i] && JSON.stringify(canon(ours[i])) === JSON.stringify(canon(def))) structurallyIdentical++;
    });
  }
  return { defCountMismatches, structurallyIdentical, defs };
}

export interface CompiledCasesDeps {
  cwd: string;
  load: (contentDir: string, measure: OfficialMeasureId) => LoadedOfficialMeasure;
  run: typeof runOfficialMeasureCases;
  verifyUpstream: (contentDir: string, measure: OfficialMeasureId) => void;
  modelInfos: () => ModelInfoFile[];
  log: (message: string) => void;
  error: (message: string) => void;
}

export function defaultCompiledCasesDeps(): CompiledCasesDeps {
  return {
    cwd: process.cwd(),
    load: loadOfficialMeasureCases,
    run: runOfficialMeasureCases,
    verifyUpstream: verifyUpstreamBundle,
    modelInfos: () => loadQiCoreModelInfos(),
    log: console.log,
    error: console.error,
  };
}

async function runBoth(deps: CompiledCasesDeps, loaded: LoadedOfficialMeasure, compiledBundle: LoadedOfficialMeasure["measureBundle"]) {
  let upstreamOutput: FqmOutput | undefined;
  let compiledOutput: FqmOutput | undefined;
  const upstreamRun = await deps.run(loaded, { onOutput: (o) => (upstreamOutput = o) });
  const compiledRun = await deps.run({ ...loaded, measureBundle: compiledBundle }, { onOutput: (o) => (compiledOutput = o) });
  return { upstream: { run: upstreamRun, output: upstreamOutput }, compiled: { run: compiledRun, output: compiledOutput } };
}

/** Break a copy of the main library's "Initial Population" so a run on it MUST disagree with CMS's. */
export function breakInitialPopulation(compiled: readonly CompiledLibrary[], mainLibrary: string): CompiledLibrary[] {
  const copy = JSON.parse(JSON.stringify(compiled)) as CompiledLibrary[];
  const main = copy.find((library) => library.name === mainLibrary);
  const def = defsOf(main?.elm).find((d) => d.name === "Initial Population") as (ElmDef & { expression?: unknown }) | undefined;
  if (!def) throw new Error(`${mainLibrary} has no "Initial Population" define to break`);
  def.expression = { type: "Literal", valueType: "{urn:hl7-org:elm-types:r1}Boolean", value: "false" };
  return copy;
}

export async function main(argv: string[], overrides: Partial<CompiledCasesDeps> = {}): Promise<number> {
  const deps = { ...defaultCompiledCasesDeps(), ...overrides };
  let args: CompiledCasesArgs;
  let modelInfos: ModelInfoFile[];
  try {
    args = parseArgs(argv);
    modelInfos = deps.modelInfos();
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const contentDir = resolve(deps.cwd, args.contentDir ?? ".official-content");
  const results: MeasureComparison[] = [];
  let failed = false;

  for (const measure of args.measures) {
    let loaded: LoadedOfficialMeasure;
    try {
      deps.verifyUpstream(contentDir, measure);
      loaded = deps.load(contentDir, measure);
    } catch (error) {
      deps.error(`${measure}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    const problems: string[] = [];
    let compiled: CompiledLibrary[] = [];
    let r: MeasureComparison;
    try {
      const libraries = bundleLibraries(loaded.measureBundle);
      for (const library of libraries) assertCmsTranslatorOptions(library.resource as { name?: string; contained?: unknown[] });
      compiled = compileLibrarySet(libraries, { modelInfos, signatureLevel: args.signatureLevel });
      const shape = structure(compiled, new Map(libraries.map((l) => [l.name, l.upstreamElm])));
      if (args.elmOut) {
        const dir = resolve(deps.cwd, args.elmOut, measure);
        mkdirSync(dir, { recursive: true });
        for (const library of compiled) writeFileSync(join(dir, `${library.name}-${library.version}.json`), `${JSON.stringify(library.elm)}\n`);
      }
      const { upstream, compiled: ours } = await runBoth(deps, loaded, withCompiledElm(loaded.measureBundle, compiled));
      const comparison: MeasureComparison = { ...compareRuns(measure, upstream, ours), ...shape, problems };
      const required = REQUIRED_OFFICIAL_CASE_COUNTS[measure] ?? 0;
      if (comparison.cases < required) problems.push(`deck has ${comparison.cases} cases, at least ${required} required`);
      if (upstream.run.calculationError || ours.run.calculationError) problems.push(`calculation error: ${upstream.run.calculationError ?? ours.run.calculationError}`);
      if (comparison.compiled.errors > 0) problems.push(`${comparison.compiled.errors} case error(s) on our ELM`);
      if (upstream.run.trustMetaProfile !== ours.run.trustMetaProfile) problems.push("the profile retry ran on one side only");
      for (const [label, count] of [["status", comparison.statusEqual], ["rates", comparison.ratesEqual], ["stratifiers", comparison.stratifiersEqual]] as const) {
        if (count !== comparison.cases) problems.push(`${label} differ on ${comparison.cases - count} case(s)`);
      }
      if (comparison.statementsDiffering > 0) problems.push(`${comparison.statementsDiffering} per-statement result(s) differ`);
      if (comparison.statementsCompared !== PINNED_STATEMENT_RESULTS[measure]) {
        problems.push(`compared ${comparison.statementsCompared} statement results, ${PINNED_STATEMENT_RESULTS[measure]} pinned`);
      }
      problems.push(...shape.defCountMismatches);
      r = comparison;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      r = { measure, cases: 0, statusEqual: 0, ratesEqual: 0, stratifiersEqual: 0, statementsCompared: 0, statementsDiffering: 0, samples: [], defCountMismatches: [], structurallyIdentical: 0, defs: 0, upstream: emptySummary(), compiled: emptySummary(), problems };
    }
    results.push(r);
    deps.log(
      `${measure}: ${r.cases} cases · status ${r.statusEqual} · rates ${r.ratesEqual} · stratifiers ${r.stratifiersEqual} · ` +
        `statements ${r.statementsCompared - r.statementsDiffering}/${r.statementsCompared} equal · ` +
        `defs structurally identical ${r.structurallyIdentical}/${r.defs} (informational) · ` +
        `${r.problems.length === 0 ? "PASS" : `FAIL: ${r.problems.join("; ")}`}`,
    );
    for (const sample of r.samples.slice(0, 5)) deps.log(`  ${sample}`);
    if (r.problems.length > 0) failed = true;

    // Non-vacuity: the same comparison on a deliberately broken copy must FAIL, or the gate is not
    // looking at our ELM at all (a bundle that quietly fell back to CMS's would pass everything).
    if (measure === NON_VACUITY_MEASURE && compiled.length > 0) {
      const broken = withCompiledElm(loaded.measureBundle, breakInitialPopulation(compiled, loaded.measureName));
      const { upstream, compiled: ours } = await runBoth(deps, loaded, broken);
      const check = compareRuns(measure, upstream, ours);
      const moved = check.cases - check.ratesEqual;
      deps.log(`${measure}: non-vacuity check, "Initial Population" forced false → ${moved} case(s) move ${moved > 0 ? "(the gate runs our ELM)" : "— FAIL: the gate is not running our ELM"}`);
      if (moved === 0) failed = true;
    }
  }

  const totals = results.reduce(
    (sum, r) => ({ cases: sum.cases + r.cases, statements: sum.statements + r.statementsCompared, differing: sum.differing + r.statementsDiffering }),
    { cases: 0, statements: 0, differing: 0 },
  );
  deps.log(
    `compiled-ELM calibration (${args.signatureLevel}): ${results.length} measure(s), ${totals.cases} cases, ` +
      `${totals.differing} of ${totals.statements} statement results differ — ${failed ? "FAIL" : "PASS"}`,
  );
  return failed ? 1 : 0;
}

function emptySummary(): OfficialMeasureRun["summary"] {
  return { total: 0, expectedAgreements: 0, referenceAgreements: 0, unexpectedMismatches: 0, errors: 0 };
}
