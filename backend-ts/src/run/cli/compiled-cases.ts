/**
 * The calibration gate for the QI-Core compile path: compile each pilot measure's libraries FROM CMS's
 * CQL with our translator (`standards/qicore-compile.ts`), run CMS's MADiE deck on our ELM and on CMS's
 * own, and require the two to agree on every case, every rate, every stratifier and every define's value
 * (not just fqm's TRUE/FALSE/NA label). A 2027 translation is only as trustworthy as the compiler that builds it; this is what shows
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
 * Define values each deck must compare: one per (non-function define × group × patient) in CMS's ELM
 * run. A pinned count, not a floor: if it moves, either the deck or what fqm reports changed, and zero
 * differences would no longer mean what they meant.
 */
export const PINNED_STATEMENT_RESULTS: Record<CompiledGateMeasure, number> = {
  cms122: 2090,
  cms125: 2772,
  cms130: 2688,
  cms137: 2970,
  cms165: 2992,
  cms2: 1368,
};

/**
 * The measure the non-vacuity checks break: multi-rate, so its "Initial Population" moves both rates, and
 * its "SDE Sex" define changes a value without moving any population.
 */
export const NON_VACUITY_MEASURE: CompiledGateMeasure = "cms137";
export const VALUE_PROBE_DEFINE = "SDE Sex";

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
  /** fqm's four-value label (TRUE/FALSE/UNHIT/NA) — truthiness and relevance, NOT the value. */
  final?: unknown;
  relevance?: unknown;
  /** The define's actual value (fqm returns it under verboseCalculationResults). */
  raw?: unknown;
  /** A function def has no value of its own; its label depends on relevance alone. */
  isFunction?: boolean;
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

/**
 * A case's populations as one string: each rate's five counts in `POPULATION_CODES` order (an undeclared
 * population is 0), rates joined by `|` — `"11100"`, or `"11100|11000"` for two rates. A translation's
 * `madie-expected-differences.json` writes a population difference in exactly this form.
 */
export const rateVector = (rates: PopulationCounts[] | undefined): string =>
  (rates ?? []).map((rate) => POPULATION_CODES.map((code) => rate[code]).join("")).join("|");

/**
 * A define's value in a form two runs can compare: FHIR objects by their JSON, cql-execution values
 * (DateTime, Interval, Quantity, Code…) by their type and fields, plain objects with sorted keys. Never
 * `toString()` — on a cql-execution Code it is "[object Object]", which would make every code equal.
 */
export function canonicalValue(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, node: unknown) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    if ("_json" in node) return (node as { _json: unknown })._json;
    const fields = Object.entries(node)
      .filter(([, v]) => typeof v !== "function")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const ctor = (node as { constructor?: { name?: string } }).constructor;
    return ctor && ctor !== Object ? { __type: ctor.name, ...Object.fromEntries(fields) } : Object.fromEntries(fields);
  });
}

/**
 * Per patient: each define's value plus fqm's label and relevance, keyed by group, library and name.
 * Functions are left out: they have no value, and overloads share a name.
 */
export function statementsByPatient(output: FqmOutput | undefined): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const result of output?.results ?? []) {
    const statements = new Map<string, string>();
    ((result.detailedResults ?? []) as DetailedResult[]).forEach((detail, group) => {
      for (const s of detail.statementResults ?? []) {
        if (s.isFunction) continue;
        statements.set(
          `g${group}|${s.libraryName}.${s.statementName}`,
          `${canonicalValue(s.raw)}|${JSON.stringify(s.final ?? null)}|${String(s.relevance ?? "")}`,
        );
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

/**
 * One define value that differs between the two runs, exactly as `statementsByPatient` compared it: the
 * case, the key (`g<group>|<library>.<define>`) and each side's compared string (value, fqm's label and
 * relevance), `null` where that side reported no such define. It is what a translation's
 * `madie-expected-differences.json` lists entry for entry, so it is never capped or reworded.
 */
export interface StatementDifference {
  /** The case's uuid. */
  case: string;
  key: string;
  cms: string | null;
  ours: string | null;
}

/**
 * One case whose populations (`rateVector`) or agreement status differs between the two runs: the case's
 * uuid and each side's string. A population difference is the form a translation's
 * `madie-expected-differences.json` lists, so neither list is capped.
 */
export interface CaseDifference {
  case: string;
  cms: string;
  ours: string;
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
  /** Every differing define value, uncapped: exactly `statementsDiffering` entries, in the order compared. */
  statementDifferences: StatementDifference[];
  /**
   * Every case not counted in `ratesEqual` that both runs hold, uncapped, as the two `rateVector`s. A case
   * whose two vectors are both empty is listed with equal sides: it is no agreement, and no file can
   * excuse it.
   */
  populationDifferences: CaseDifference[];
  /** Every case not counted in `statusEqual` that both runs hold, uncapped (status, else error, else "none"). */
  statusDifferences: CaseDifference[];
  /** The first 15 differences of any kind, as readable lines — for a log, never for a decision. */
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
  const statementDifferences: StatementDifference[] = [];
  const populationDifferences: CaseDifference[] = [];
  const statusDifferences: CaseDifference[] = [];
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
    const ourStatus = ours.agreement?.status ?? ours.error ?? "none";
    const theirStatus = theirs.agreement?.status ?? theirs.error ?? "none";
    if (ourStatus === theirStatus) statusEqual++;
    else {
      statusDifferences.push({ case: ours.uuid, cms: theirStatus, ours: ourStatus });
      if (samples.length < 15) samples.push(`${ours.uuid}: status ${theirs.agreement?.status ?? theirs.error} vs ours ${ours.agreement?.status ?? ours.error}`);
    }
    const ourRates = rateVector(ours.actualRates);
    const theirRates = rateVector(theirs.actualRates);
    if (ourRates === theirRates && ourRates !== "") ratesEqual++;
    else {
      populationDifferences.push({ case: ours.uuid, cms: theirRates, ours: ourRates });
      if (samples.length < 15) samples.push(`${ours.uuid}: rates ${theirRates} vs ours ${ourRates}`);
    }
    const pid = String(ours.patientId);
    if (upStrata.get(pid) === ourStrata.get(pid)) stratifiersEqual++;
    const up = upStatements.get(pid) ?? new Map<string, string>();
    const ourMap = ourStatements.get(pid) ?? new Map<string, string>();
    for (const [key, value] of up) {
      statementsCompared++;
      if (ourMap.get(key) !== value) {
        statementsDiffering++;
        statementDifferences.push({ case: ours.uuid, key, cms: value, ours: ourMap.get(key) ?? null });
        if (samples.length < 15) samples.push(`${ours.uuid} ${key}: ${value} vs ours ${ourMap.get(key)}`);
      }
    }
    for (const [key, value] of ourMap) {
      if (up.has(key)) continue;
      statementsDiffering++;
      statementDifferences.push({ case: ours.uuid, key, cms: null, ours: value });
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
    statementDifferences,
    populationDifferences,
    statusDifferences,
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
  pinnedStatements: Readonly<Record<string, number>>;
  requiredCases: Readonly<Record<string, number>>;
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
    pinnedStatements: PINNED_STATEMENT_RESULTS,
    requiredCases: REQUIRED_OFFICIAL_CASE_COUNTS,
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

/** A copy of the compiled libraries with one main-library define replaced by a literal. */
export function breakDefine(
  compiled: readonly CompiledLibrary[],
  mainLibrary: string,
  define: string,
  literal: { valueType: string; value: string },
): CompiledLibrary[] {
  const copy = JSON.parse(JSON.stringify(compiled)) as CompiledLibrary[];
  const main = copy.find((library) => library.name === mainLibrary);
  const def = defsOf(main?.elm).find((d) => d.name === define) as (ElmDef & { expression?: unknown }) | undefined;
  if (!def) throw new Error(`${mainLibrary} has no "${define}" define to break`);
  def.expression = { type: "Literal", ...literal };
  return copy;
}

/** Break "Initial Population" so a run on the copy MUST disagree with CMS's on populations. */
export const breakInitialPopulation = (compiled: readonly CompiledLibrary[], mainLibrary: string): CompiledLibrary[] =>
  breakDefine(compiled, mainLibrary, "Initial Population", { valueType: "{urn:hl7-org:elm-types:r1}Boolean", value: "false" });

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
      const required = deps.requiredCases[measure] ?? 0;
      if (comparison.cases < required) problems.push(`deck has ${comparison.cases} cases, at least ${required} required`);
      if (upstream.run.calculationError || ours.run.calculationError) problems.push(`calculation error: ${upstream.run.calculationError ?? ours.run.calculationError}`);
      if (comparison.compiled.errors > 0) problems.push(`${comparison.compiled.errors} case error(s) on our ELM`);
      if (upstream.run.trustMetaProfile !== ours.run.trustMetaProfile) problems.push("the profile retry ran on one side only");
      for (const [label, count] of [["status", comparison.statusEqual], ["rates", comparison.ratesEqual], ["stratifiers", comparison.stratifiersEqual]] as const) {
        if (count !== comparison.cases) problems.push(`${label} differ on ${comparison.cases - count} case(s)`);
      }
      if (comparison.statementsDiffering > 0) problems.push(`${comparison.statementsDiffering} define value(s) differ`);
      if (comparison.statementsCompared !== deps.pinnedStatements[measure]) {
        problems.push(`compared ${comparison.statementsCompared} define values, ${deps.pinnedStatements[measure]} pinned`);
      }
      problems.push(...shape.defCountMismatches);
      r = comparison;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      r = { measure, cases: 0, statusEqual: 0, ratesEqual: 0, stratifiersEqual: 0, statementsCompared: 0, statementsDiffering: 0, statementDifferences: [], populationDifferences: [], statusDifferences: [], samples: [], defCountMismatches: [], structurallyIdentical: 0, defs: 0, upstream: emptySummary(), compiled: emptySummary(), problems };
    }
    results.push(r);
    deps.log(
      `${measure}: ${r.cases} cases · status ${r.statusEqual} · rates ${r.ratesEqual} · stratifiers ${r.stratifiersEqual} · ` +
        `define values ${r.statementsCompared - r.statementsDiffering}/${r.statementsCompared} equal · ` +
        `defs structurally identical ${r.structurallyIdentical}/${r.defs} (informational) · ` +
        `${r.problems.length === 0 ? "PASS" : `FAIL: ${r.problems.join("; ")}`}`,
    );
    for (const sample of r.samples.slice(0, 5)) deps.log(`  ${sample}`);
    if (r.problems.length > 0) failed = true;

    // Non-vacuity: the same comparison on deliberately broken copies must FAIL, or the gate is not
    // looking at our ELM at all (a bundle that quietly fell back to CMS's would pass everything). One
    // break moves populations; the other changes only a define's value, which only the value
    // comparison can see.
    if (measure === NON_VACUITY_MEASURE && compiled.length > 0) {
      const brokenPopulations = await runBoth(deps, loaded, withCompiledElm(loaded.measureBundle, breakInitialPopulation(compiled, loaded.measureName)));
      const populations = compareRuns(measure, brokenPopulations.upstream, brokenPopulations.compiled);
      const moved = populations.cases - populations.ratesEqual;
      deps.log(`${measure}: non-vacuity, "Initial Population" forced false → ${moved} case(s) move ${moved > 0 ? "(the gate runs our ELM)" : "— FAIL: the gate is not running our ELM"}`);
      if (moved === 0) failed = true;

      const valueBreak = breakDefine(compiled, loaded.measureName, VALUE_PROBE_DEFINE, { valueType: "{urn:hl7-org:elm-types:r1}String", value: "not the value" });
      const brokenValue = await runBoth(deps, loaded, withCompiledElm(loaded.measureBundle, valueBreak));
      const values = compareRuns(measure, brokenValue.upstream, brokenValue.compiled);
      deps.log(
        `${measure}: non-vacuity, "${VALUE_PROBE_DEFINE}" replaced → ${values.statementsDiffering} define value(s) differ ` +
          `${values.statementsDiffering > 0 ? "(the gate compares values)" : "— FAIL: the gate is not comparing values"}`,
      );
      if (values.statementsDiffering === 0) failed = true;
    }
  }

  const totals = results.reduce(
    (sum, r) => ({ cases: sum.cases + r.cases, statements: sum.statements + r.statementsCompared, differing: sum.differing + r.statementsDiffering }),
    { cases: 0, statements: 0, differing: 0 },
  );
  deps.log(
    `compiled-ELM calibration (${args.signatureLevel}): ${results.length} measure(s), ${totals.cases} cases, ` +
      `${totals.differing} of ${totals.statements} define values differ — ${failed ? "FAIL" : "PASS"}`,
  );
  return failed ? 1 : 0;
}

function emptySummary(): OfficialMeasureRun["summary"] {
  return { total: 0, expectedAgreements: 0, referenceAgreements: 0, unexpectedMismatches: 0, errors: 0 };
}
