/**
 * Offline official MADiE case diagnostics for CMS122/CMS125.
 *
 * DIAGNOSTIC-ONLY (ADR-026): this module is reachable only from the on-demand CLI. It never serves
 * the request path, worker entrypoint, engine ingress, or production run pipeline.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const POPULATION_CODES = [
  "initial-population",
  "denominator",
  "denominator-exclusion",
  "numerator",
] as const;
export type PopulationCode = (typeof POPULATION_CODES)[number];
export type OfficialMeasureId = "cms122" | "cms125";
export type PopulationCounts = Record<PopulationCode, number>;

const MEASURES: Record<OfficialMeasureId, { name: string; bundleFile: string }> = {
  cms122: {
    name: "CMS122FHIRDiabetesAssessGT9Pct",
    bundleFile: "CMS122FHIRDiabetesAssessGT9Pct-bundle.json",
  },
  cms125: {
    name: "CMS125FHIRBreastCancerScreen",
    bundleFile: "CMS125FHIRBreastCancerScreen-bundle.json",
  },
};

export const CMS122_KNOWN_BAD_EXPECTEDS = new Set([
  "ede0ee7a-18ab-4ba7-934c-23618f1270ea",
  "e61be907-af68-493f-a6bc-3d93ef8b6c6e",
  "cade5021-b1bf-43e9-a0a4-659c05b386d0",
  "3b62b0a8-44f2-4365-bcb9-7cadef5bab2e",
  "9cba6cfa-9671-4850-803d-e286c7d59ee7",
  "f5771b74-a7de-439a-a51f-49a3863e086b",
]);

export interface FhirResource {
  resourceType: string;
  id?: string;
  [key: string]: unknown;
}

export interface FhirBundle extends FhirResource {
  resourceType: "Bundle";
  type?: string;
  entry: Array<{ resource: FhirResource }>;
}

export interface MeasurementPeriod {
  start: string;
  end: string;
}

export interface OfficialCase {
  uuid: string;
  name: string;
  title: string;
  series: string;
  description: string;
  patientId?: string;
  patientBundle?: FhirBundle;
  expected?: PopulationCounts;
  expectedScore?: number;
  loadError?: string;
}

export interface ValueSetStats {
  total: number;
  expanded: number;
  truncated: Array<{ url: string; expectedTotal: number; availableCodes: number }>;
}

export interface LoadedOfficialMeasure {
  measure: OfficialMeasureId;
  measureName: string;
  contentDir: string;
  measureBundle: FhirBundle;
  cases: OfficialCase[];
  measurementPeriod: MeasurementPeriod;
  valueSets: ValueSetStats;
  valueSetResources: FhirResource[];
}

export interface OfficialCaseName {
  name: string;
  title: string;
  series: string;
  description: string;
}

interface MadieManifestEntry {
  patientId?: unknown;
  title?: unknown;
  series?: unknown;
  description?: unknown;
}

/** Parse MADiE's JSON manifest into display metadata keyed by patient/test-case UUID. */
export function parseMadieManifest(raw: string): Map<string, OfficialCaseName> {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("MADiE manifest must be a JSON array");

  const result = new Map<string, OfficialCaseName>();
  for (const candidate of parsed as MadieManifestEntry[]) {
    if (
      typeof candidate.patientId !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.series !== "string"
    ) {
      throw new Error("MADiE manifest entry is missing patientId, title, or series");
    }
    const description = typeof candidate.description === "string" ? candidate.description : "";
    result.set(candidate.patientId, {
      name: `${candidate.series} ${candidate.title}`,
      title: candidate.title,
      series: candidate.series,
      description,
    });
  }
  return result;
}

/** README fallback for exports whose JSON `.madie` manifest is absent. */
export function parseMadieReadme(raw: string): Map<string, OfficialCaseName> {
  const result = new Map<string, OfficialCaseName>();
  const row = /^Case\s+#\s+\d+\s+-\s+([0-9a-f-]{36})\s+=\s+(\S+)\s+(.+)$/gim;
  for (const match of raw.matchAll(row)) {
    const patientId = match[1]!;
    const series = match[2]!;
    const title = match[3]!.trim();
    result.set(patientId, { name: `${series} ${title}`, title, series, description: "" });
  }
  return result;
}

function readJson(path: string): FhirResource {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as FhirResource).resourceType !== "string") {
    throw new Error(`${path} is not a FHIR resource JSON object`);
  }
  return parsed as FhirResource;
}

function readBundle(path: string): FhirBundle {
  const resource = readJson(path);
  if (resource.resourceType !== "Bundle" || !Array.isArray(resource.entry)) {
    throw new Error(`${path} is not a FHIR Bundle with entries`);
  }
  return resource as FhirBundle;
}

export function loadFhirBundleFile(path: string): FhirBundle {
  return readBundle(path);
}

function populationCounts(report: FhirResource): PopulationCounts {
  const counts: PopulationCounts = {
    "initial-population": 0,
    denominator: 0,
    "denominator-exclusion": 0,
    numerator: 0,
  };
  const group = Array.isArray(report.group) ? report.group[0] as Record<string, unknown> | undefined : undefined;
  const populations = group && Array.isArray(group.population) ? group.population : [];
  for (const population of populations as Array<Record<string, unknown>>) {
    const code = population.code as { coding?: Array<{ code?: string }> } | undefined;
    const populationCode = code?.coding?.map((coding) => coding.code).find(
      (candidate): candidate is PopulationCode => POPULATION_CODES.includes(candidate as PopulationCode),
    );
    if (!populationCode) continue;
    if (typeof population.count !== "number" || !Number.isInteger(population.count)) {
      throw new Error(`expected MeasureReport population ${populationCode} has a non-integer count`);
    }
    counts[populationCode] = population.count;
  }
  return counts;
}

function reportPeriod(report: FhirResource): MeasurementPeriod {
  const period = report.period as { start?: unknown; end?: unknown } | undefined;
  if (typeof period?.start !== "string" || typeof period.end !== "string") {
    throw new Error("expected MeasureReport is missing period.start or period.end");
  }
  return { start: period.start, end: period.end };
}

function reportScore(report: FhirResource): number | undefined {
  const group = Array.isArray(report.group) ? report.group[0] as Record<string, unknown> | undefined : undefined;
  const score = group?.measureScore as { value?: unknown } | undefined;
  return typeof score?.value === "number" ? score.value : undefined;
}

function countExpandedCodes(contains: unknown): number {
  if (!Array.isArray(contains)) return 0;
  let count = 0;
  for (const item of contains as Array<{ code?: unknown; contains?: unknown }>) {
    if (typeof item.code === "string") count++;
    count += countExpandedCodes(item.contains);
  }
  return count;
}

function valueSetStats(bundle: FhirBundle): ValueSetStats {
  const valueSets = bundle.entry
    .map((entry) => entry.resource)
    .filter((resource) => resource.resourceType === "ValueSet");
  const truncated: ValueSetStats["truncated"] = [];
  let expanded = 0;
  for (const valueSet of valueSets) {
    const expansion = valueSet.expansion as { total?: unknown; contains?: unknown } | undefined;
    const availableCodes = countExpandedCodes(expansion?.contains);
    if (availableCodes > 0) expanded++;
    if (typeof expansion?.total === "number" && expansion.total > availableCodes) {
      truncated.push({
        url: typeof valueSet.url === "string" ? valueSet.url : valueSet.id ?? "(unknown ValueSet)",
        expectedTotal: expansion.total,
        availableCodes,
      });
    }
  }
  return { total: valueSets.length, expanded, truncated };
}

function loadCase(caseDir: string, uuid: string, metadata?: OfficialCaseName): { caseData: OfficialCase; period?: MeasurementPeriod } {
  const fallback: OfficialCaseName = metadata ?? { name: uuid, title: uuid, series: "Unmapped", description: "" };
  const base: OfficialCase = { uuid, ...fallback };
  try {
    const resources = readdirSync(caseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => readJson(join(caseDir, entry.name)));
    const reports = resources.filter((resource) => resource.resourceType === "MeasureReport");
    if (reports.length !== 1) throw new Error(`expected exactly one MeasureReport, found ${reports.length}`);
    const patients = resources.filter((resource) => resource.resourceType === "Patient");
    if (patients.length !== 1 || typeof patients[0]!.id !== "string") {
      throw new Error(`expected exactly one Patient with an id, found ${patients.length}`);
    }
    const report = reports[0]!;
    const patientResources = resources.filter((resource) => resource.resourceType !== "MeasureReport");
    return {
      caseData: {
        ...base,
        patientId: patients[0]!.id,
        patientBundle: {
          resourceType: "Bundle",
          type: "collection",
          entry: patientResources.map((resource) => ({ resource })),
        },
        expected: populationCounts(report),
        expectedScore: reportScore(report),
      },
      period: reportPeriod(report),
    };
  } catch (error) {
    return { caseData: { ...base, loadError: error instanceof Error ? error.message : String(error) } };
  }
}

/** Load one official measure bundle and every loose-resource MADiE case beneath it. */
export function loadOfficialMeasureCases(contentDir: string, measure: OfficialMeasureId): LoadedOfficialMeasure {
  const config = MEASURES[measure];
  const resolvedContentDir = resolve(contentDir);
  const measureBundle = readBundle(join(resolvedContentDir, "bundles", "measure", config.name, config.bundleFile));
  const testsDir = join(resolvedContentDir, "input", "tests", "measure", config.name);
  const manifestPath = join(testsDir, ".madie");
  const readmePath = join(testsDir, "README.txt");
  const metadata = existsSync(manifestPath)
    ? parseMadieManifest(readFileSync(manifestPath, "utf8"))
    : parseMadieReadme(readFileSync(readmePath, "utf8"));

  const cases: OfficialCase[] = [];
  let measurementPeriod: MeasurementPeriod | undefined;
  for (const entry of readdirSync(testsDir, { withFileTypes: true })
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const loaded = loadCase(join(testsDir, entry.name), entry.name, metadata.get(entry.name));
    if (loaded.period) {
      if (
        measurementPeriod &&
        (measurementPeriod.start !== loaded.period.start || measurementPeriod.end !== loaded.period.end)
      ) {
        loaded.caseData.loadError =
          `measurement period ${loaded.period.start}..${loaded.period.end} does not match ` +
          `${measurementPeriod.start}..${measurementPeriod.end}`;
        delete loaded.caseData.patientBundle;
        delete loaded.caseData.expected;
      } else {
        measurementPeriod ??= loaded.period;
      }
    }
    cases.push(loaded.caseData);
  }
  if (!measurementPeriod) throw new Error(`${config.name}: no valid expected MeasureReport measurement period found`);

  return {
    measure,
    measureName: config.name,
    contentDir: resolvedContentDir,
    measureBundle,
    cases,
    measurementPeriod,
    valueSets: valueSetStats(measureBundle),
    valueSetResources: measureBundle.entry
      .map((entry) => entry.resource)
      .filter((resource) => resource.resourceType === "ValueSet"),
  };
}

export interface PopulationAgreement {
  pass: boolean;
  status: "expected-agreement" | "reference-agreement" | "mismatch";
  differences: PopulationCode[];
}

/** Classify raw population agreement, with the source repo's six CMS122 expected-result defects isolated. */
export function classifyPopulationAgreement(
  measure: OfficialMeasureId,
  uuid: string,
  expected: PopulationCounts,
  actual: PopulationCounts,
): PopulationAgreement {
  const differences = POPULATION_CODES.filter((code) => expected[code] !== actual[code]);
  if (differences.length === 0) return { pass: true, status: "expected-agreement", differences };
  const isKnownReferenceAgreement =
    measure === "cms122" &&
    CMS122_KNOWN_BAD_EXPECTEDS.has(uuid) &&
    differences.length === 1 &&
    differences[0] === "numerator" &&
    expected.numerator === 0 &&
    actual.numerator === 1;
  return {
    pass: isKnownReferenceAgreement,
    status: isKnownReferenceAgreement ? "reference-agreement" : "mismatch",
    differences,
  };
}

interface FqmPopulationResult {
  populationType: string;
  result: boolean;
}

interface FqmExecutionResult {
  patientId?: string;
  evaluatedResource?: FhirResource[];
  detailedResults?: Array<{ populationResults?: FqmPopulationResult[] }>;
}

interface FqmOutput {
  results?: FqmExecutionResult[];
  withErrors?: unknown[];
}

export interface FqmCalculationOptions {
  measurementPeriodStart: string;
  measurementPeriodEnd: string;
  calculateSDEs: false;
  calculateHTML: false;
  calculateClauseCoverage: false;
  calculateRAVs: false;
  trustMetaProfile: boolean;
  verboseCalculationResults: true;
}

export type FqmCalculate = (
  measureBundle: unknown,
  patientBundles: unknown[],
  options: FqmCalculationOptions,
  valueSetCache?: unknown[],
) => Promise<FqmOutput>;

export interface OfficialCaseResult extends OfficialCase {
  actual?: PopulationCounts;
  agreement?: PopulationAgreement;
  error?: string;
}

export interface OfficialRunSummary {
  total: number;
  expectedAgreements: number;
  referenceAgreements: number;
  unexpectedMismatches: number;
  errors: number;
}

export interface OfficialMeasureRun {
  measure: OfficialMeasureId;
  measureName: string;
  measurementPeriod: MeasurementPeriod;
  valueSets: ValueSetStats;
  valueSetMode: "measure-bundle";
  trustMetaProfile: boolean;
  profileRetry: boolean;
  retrieveSignal: boolean;
  engineWarnings: number;
  calculationError?: string;
  cases: OfficialCaseResult[];
  summary: OfficialRunSummary;
  draftDrift?: Cms122DraftDrift;
}

function calculationOptions(period: MeasurementPeriod, trustMetaProfile: boolean): FqmCalculationOptions {
  return {
    measurementPeriodStart: period.start,
    measurementPeriodEnd: /^\d{4}-\d{2}-\d{2}$/.test(period.end)
      ? `${period.end}T23:59:59.999Z`
      : period.end,
    calculateSDEs: false,
    calculateHTML: false,
    calculateClauseCoverage: false,
    calculateRAVs: false,
    trustMetaProfile,
    verboseCalculationResults: true,
  };
}

function hasRetrieveSignal(output: FqmOutput): boolean {
  return (output.results ?? []).some((result) => {
    const hasNonPatientResource = result.evaluatedResource?.some((resource) => resource.resourceType !== "Patient") ?? false;
    const hasPopulationMembership = result.detailedResults?.[0]?.populationResults?.some((population) => population.result) ?? false;
    return hasNonPatientResource || hasPopulationMembership;
  });
}

function actualPopulationCounts(populations: FqmPopulationResult[]): PopulationCounts {
  const actual: PopulationCounts = {
    "initial-population": 0,
    denominator: 0,
    "denominator-exclusion": 0,
    numerator: 0,
  };
  for (const population of populations) {
    if (POPULATION_CODES.includes(population.populationType as PopulationCode)) {
      actual[population.populationType as PopulationCode] = population.result ? 1 : 0;
    }
  }
  return actual;
}

function summarizeCases(cases: OfficialCaseResult[]): OfficialRunSummary {
  return {
    total: cases.length,
    expectedAgreements: cases.filter((item) => item.agreement?.status === "expected-agreement").length,
    referenceAgreements: cases.filter((item) => item.agreement?.status === "reference-agreement").length,
    unexpectedMismatches: cases.filter((item) => item.agreement?.status === "mismatch").length,
    errors: cases.filter((item) => item.error || item.loadError).length,
  };
}

export interface RunOfficialMeasureOptions {
  calculate?: FqmCalculate;
}

/** Execute all valid cases for one measure in a single fqm-execution batch. */
export async function runOfficialMeasureCases(
  loaded: LoadedOfficialMeasure,
  options: RunOfficialMeasureOptions = {},
): Promise<OfficialMeasureRun> {
  const calculate: FqmCalculate =
    options.calculate ?? (await import("fqm-execution")).Calculator.calculate as unknown as FqmCalculate;
  const validCases = loaded.cases.filter(
    (item): item is OfficialCase & Required<Pick<OfficialCase, "patientId" | "patientBundle" | "expected">> =>
      !item.loadError && !!item.patientId && !!item.patientBundle && !!item.expected,
  );

  let output: FqmOutput;
  let trustMetaProfile = false;
  let profileRetry = false;
  try {
    output = await calculate(
      loaded.measureBundle,
      validCases.map((item) => item.patientBundle),
      calculationOptions(loaded.measurementPeriod, false),
    );
    if (!hasRetrieveSignal(output) && validCases.length > 0) {
      profileRetry = true;
      trustMetaProfile = true;
      output = await calculate(
        loaded.measureBundle,
        validCases.map((item) => item.patientBundle),
        calculationOptions(loaded.measurementPeriod, true),
      );
    }
  } catch (error) {
    const calculationError = error instanceof Error ? error.message : String(error);
    const cases = loaded.cases.map((item) => ({ ...item, ...(item.loadError ? {} : { error: calculationError }) }));
    return {
      measure: loaded.measure,
      measureName: loaded.measureName,
      measurementPeriod: loaded.measurementPeriod,
      valueSets: loaded.valueSets,
      valueSetMode: "measure-bundle",
      trustMetaProfile,
      profileRetry,
      retrieveSignal: false,
      engineWarnings: 0,
      calculationError,
      cases,
      summary: summarizeCases(cases),
    };
  }

  const byPatient = new Map((output.results ?? []).map((result) => [result.patientId, result]));
  const cases: OfficialCaseResult[] = loaded.cases.map((item) => {
    if (item.loadError || !item.patientId || !item.expected) return { ...item };
    const result = byPatient.get(item.patientId);
    const populations = result?.detailedResults?.[0]?.populationResults;
    if (!result || !populations) return { ...item, error: "fqm-execution returned no population result for patientId" };
    const actual = actualPopulationCounts(populations);
    return {
      ...item,
      actual,
      agreement: classifyPopulationAgreement(loaded.measure, item.uuid, item.expected, actual),
    };
  });

  return {
    measure: loaded.measure,
    measureName: loaded.measureName,
    measurementPeriod: loaded.measurementPeriod,
    valueSets: loaded.valueSets,
    valueSetMode: "measure-bundle",
    trustMetaProfile,
    profileRetry,
    retrieveSignal: hasRetrieveSignal(output),
    engineWarnings: output.withErrors?.length ?? 0,
    cases,
    summary: summarizeCases(cases),
  };
}

export interface DraftDriftCase {
  uuid: string;
  name: string;
  official?: PopulationCounts;
  draft?: PopulationCounts;
  differences: PopulationCode[];
  error?: string;
}

export interface Cms122DraftDrift {
  artifactVersion: string;
  valueSetMode: "official-v1-bundle-cache";
  total: number;
  changedCases: number;
  errors: number;
  cases: DraftDriftCase[];
}

export interface RunDraftDriftOptions {
  calculate?: FqmCalculate;
}

/** Compare the older vendored CMS122 v0.5.000 artifact to the official v1 run using v1 ValueSets. */
export async function runCms122DraftDrift(
  loaded: LoadedOfficialMeasure,
  officialRun: OfficialMeasureRun,
  draftBundle: FhirBundle,
  options: RunDraftDriftOptions = {},
): Promise<Cms122DraftDrift> {
  if (loaded.measure !== "cms122" || officialRun.measure !== "cms122") {
    throw new Error("CMS122 draft drift requires a CMS122 official load and run");
  }
  const calculate: FqmCalculate =
    options.calculate ?? (await import("fqm-execution")).Calculator.calculate as unknown as FqmCalculate;
  const validCases = loaded.cases.filter(
    (item): item is OfficialCase & Required<Pick<OfficialCase, "patientId" | "patientBundle">> =>
      !item.loadError && !!item.patientId && !!item.patientBundle,
  );
  const measure = draftBundle.entry.map((entry) => entry.resource).find((resource) => resource.resourceType === "Measure");
  const artifactVersion = typeof measure?.version === "string" ? measure.version : "unknown";

  let output: FqmOutput;
  try {
    output = await calculate(
      draftBundle,
      validCases.map((item) => item.patientBundle),
      calculationOptions(loaded.measurementPeriod, officialRun.trustMetaProfile),
      loaded.valueSetResources,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cases = validCases.map((item) => ({ uuid: item.uuid, name: item.name, differences: [], error: message }));
    return {
      artifactVersion,
      valueSetMode: "official-v1-bundle-cache",
      total: cases.length,
      changedCases: 0,
      errors: cases.length,
      cases,
    };
  }

  const draftByPatient = new Map((output.results ?? []).map((result) => [result.patientId, result]));
  const officialByUuid = new Map(officialRun.cases.map((item) => [item.uuid, item]));
  const cases: DraftDriftCase[] = validCases.map((item) => {
    const official = officialByUuid.get(item.uuid)?.actual;
    const draftResult = draftByPatient.get(item.patientId);
    const populations = draftResult?.detailedResults?.[0]?.populationResults;
    if (!official || !populations) {
      return {
        uuid: item.uuid,
        name: item.name,
        official,
        differences: [],
        error: !official ? "official v1 result unavailable" : "draft v0.5 result unavailable",
      };
    }
    const draft = actualPopulationCounts(populations);
    return {
      uuid: item.uuid,
      name: item.name,
      official,
      draft,
      differences: POPULATION_CODES.filter((code) => official[code] !== draft[code]),
    };
  });
  return {
    artifactVersion,
    valueSetMode: "official-v1-bundle-cache",
    total: cases.length,
    changedCases: cases.filter((item) => item.differences.length > 0).length,
    errors: cases.filter((item) => item.error).length,
    cases,
  };
}

export interface OfficialReportMetadata {
  generatedDate: string;
  sourceRevision: string;
}

function percent(count: number, total: number): string {
  return total === 0 ? "0.0%" : `${((count / total) * 100).toFixed(1)}%`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function populationCell(item: OfficialCaseResult, code: PopulationCode): string {
  if (!item.expected || !item.actual) return "—";
  return `${item.expected[code]}/${item.actual[code]}`;
}

function resultLabel(item: OfficialCaseResult): string {
  if (item.loadError) return `ERROR (loader: ${escapeMarkdown(item.loadError)})`;
  if (item.error) return `ERROR (engine: ${escapeMarkdown(item.error)})`;
  if (item.agreement?.status === "reference-agreement") return "PASS†";
  if (item.agreement?.status === "expected-agreement") return "PASS";
  return "FAIL";
}

/** Render a deterministic evidence report for committed review. E/A means expected/actual. */
export function renderOfficialCaseReport(runs: OfficialMeasureRun[], metadata: OfficialReportMetadata): string {
  const lines = [
    "# Official MADiE eCQM Test-Case Report — July 2026",
    "",
    `**Generated:** ${metadata.generatedDate}`,
    "**Content:** `cqframework/dqm-content-qicore-2025` master (2025 AU / 2026 performance period)",
    `**Content revision:** \`${metadata.sourceRevision}\``,
    "**Engine:** `fqm-execution` 1.8.5 over pre-compiled ELM; offline, no server, DB, VSAC key, or request path",
    "",
    "Raw comparisons below are population membership only. `E/A` means expected/actual. CMS122 is an inverse measure; numerator membership is never translated into a WorkWell compliance label.",
    "",
    "## Reproduce",
    "",
    "Run from the repository root (the fetch script is Windows/PowerShell-aware and enables Git long paths):",
    "",
    "```powershell",
    "cd backend-ts",
    ".\\scripts\\fetch-official-cases.ps1",
    "pnpm test:official-cases [--measure cms122|cms125] [--content-dir <path>]",
    "# If pnpm is not directly on PATH: corepack pnpm test:official-cases",
    "```",
    "",
    "The fetch script sparse-checks out only the two measure bundles and two test-case trees into ignored `.official-content/`; it refuses to overwrite an unrelated non-Git directory.",
    "",
    "## Summary",
    "",
    "| Measure | Cases | Raw expected agreement | Known-bad expecteds matching reference | Reference-adjusted pass | Unexpected mismatches | Errors |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const run of runs) {
    const adjusted = run.summary.expectedAgreements + run.summary.referenceAgreements;
    lines.push(
      `| ${run.measure.toUpperCase()} | ${run.summary.total} | ${run.summary.expectedAgreements} (${percent(run.summary.expectedAgreements, run.summary.total)}) | ` +
        `${run.summary.referenceAgreements} | ${adjusted} (${percent(adjusted, run.summary.total)}) | ` +
        `${run.summary.unexpectedMismatches} | ${run.summary.errors} |`,
    );
  }
  lines.push(
    "",
    "† CMS122 reference agreement means the actual vector differs from the committed MADiE expected only at numerator `0→1` for one of the six UUIDs already reported by the source repo. It is an adjusted pass, not an engine defect.",
    "",
    "## Execution and terminology controls",
    "",
    "`fqm-execution` 1.8.5 reads ValueSet resources from the measure Bundle before adding any optional external cache. ValueSets are consumed directly from each official measure Bundle; no VSAC network call or key is used.",
    "",
    "**Measurement-period caveat:** date-only period ends are normalized to end-of-day because fqm-execution 1.8.5 parses them as start-of-day (upstream issue filed: projecttacoma/fqm-execution#371); the un-normalized run scores 64/66.",
    "",
  );
  for (const run of runs) {
    const profile = `trustMetaProfile=${run.trustMetaProfile}`;
    const retry = run.profileRetry ? " (retried after an empty false-profile retrieve signal)" : " (first pass; no retry)";
    lines.push(
      `- **${run.measure.toUpperCase()}:** ${profile}${retry}; ${run.valueSets.expanded}/${run.valueSets.total} Bundle ValueSets carry expansions; ` +
        `${run.valueSets.truncated.length} expansion(s) report more total codes than are present; fqm warnings=${run.engineWarnings}.`,
    );
    for (const truncated of run.valueSets.truncated) {
      lines.push(
        `  - Cap candidate: \`${truncated.url}\` — ${truncated.availableCodes}/${truncated.expectedTotal} codes present. A mismatch involving a missing code from this set must be classified as a value-set-cap candidate, not automatically as an engine bug.`,
      );
    }
  }

  const cms122 = runs.find((run) => run.measure === "cms122");
  const knownCms122 = cms122?.cases.filter((item) => CMS122_KNOWN_BAD_EXPECTEDS.has(item.uuid)) ?? [];
  if (knownCms122.length > 0) {
    lines.push("", "## Investigated findings", "");
  }
  if (knownCms122.length > 0) {
    const expectedMatches = knownCms122.filter((item) => item.agreement?.status === "expected-agreement").length;
    const referenceMatches = knownCms122.filter((item) => item.agreement?.status === "reference-agreement").length;
    lines.push(
      `- **CMS122 source calibration:** ${expectedMatches}/${knownCms122.length} known-bad-expected UUIDs matched the committed numerator=0 value; ` +
        `${referenceMatches}/${knownCms122.length} reproduced the source comparison's numerator=1 result. This is reported separately from adjusted pass/fail.`,
    );
  }
  for (const run of runs) {
    lines.push(
      "",
      `## ${run.measure.toUpperCase()} — ${run.measureName}`,
      "",
      `Measurement period: ${run.measurementPeriod.start} → ${run.measurementPeriod.end}. ` +
        `Raw expected agreement ${run.summary.expectedAgreements}/${run.summary.total}; ` +
        `reference-adjusted pass ${run.summary.expectedAgreements + run.summary.referenceAgreements}/${run.summary.total}.`,
      "",
      "| Case | UUID | IPP E/A | DENOM E/A | DENEX E/A | NUMER E/A | Result |",
      "|---|---|---:|---:|---:|---:|---|",
    );
    for (const item of run.cases) {
      lines.push(
        `| ${escapeMarkdown(item.name)} | \`${item.uuid}\` | ${populationCell(item, "initial-population")} | ` +
          `${populationCell(item, "denominator")} | ${populationCell(item, "denominator-exclusion")} | ` +
          `${populationCell(item, "numerator")} | ${resultLabel(item)} |`,
      );
    }
    if (run.draftDrift) {
      lines.push(
        "",
        `### CMS122 v1.0.000 vs vendored draft v${run.draftDrift.artifactVersion}`,
        "",
        `Using the official v1 Bundle ValueSets as the external cache, ${run.draftDrift.changedCases}/${run.draftDrift.total} cases changed population vector; ${run.draftDrift.errors} drift errors.`,
        "",
        "| Case | UUID | Changed populations | v1 IPP/DEN/DENEX/NUM | draft IPP/DEN/DENEX/NUM |",
        "|---|---|---|---|---|",
      );
      const changed = run.draftDrift.cases.filter((item) => item.differences.length > 0 || item.error);
      if (changed.length === 0) lines.push("| None | — | — | — | — |");
      for (const item of changed) {
        const vector = (counts?: PopulationCounts) => counts ? POPULATION_CODES.map((code) => counts[code]).join("/") : "ERROR";
        lines.push(
          `| ${escapeMarkdown(item.name)} | \`${item.uuid}\` | ${item.error ? escapeMarkdown(item.error) : item.differences.join(", ")} | ` +
            `${vector(item.official)} | ${vector(item.draft)} |`,
        );
      }
    }
  }

  lines.push(
    "",
    "## Interpretation rules",
    "",
    "- `PASS` = exact agreement with the committed MADiE expected population counts.",
    "- `PASS†` = exact agreement with the source repository's reference-engine discrepancy for one of the six known-bad CMS122 numerator expecteds.",
    "- `FAIL` = unexpected population mismatch requiring case-level investigation.",
    "- `ERROR` = loader or calculation failure; it is not counted as an agreement or an engine mismatch.",
    "- Expansion caps are reported independently. They are only assigned as a cause when a mismatched case actually depends on a code absent from the capped expansion.",
    "",
    "The downloaded source content remains local under `backend-ts/.official-content/` and is not committed.",
    "",
  );
  return lines.join("\n");
}
