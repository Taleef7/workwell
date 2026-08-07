/**
 * Offline official MADiE case diagnostics for every gated official measure.
 *
 * DIAGNOSTIC-ONLY (ADR-026): this module is reachable only from the on-demand CLI. It never serves
 * the request path, worker entrypoint, engine ingress, or production run pipeline.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  calculationOptions as officialCalculationOptions,
  hasRetrieveSignal as officialHasRetrieveSignal,
  loadCalculator,
  type FqmCalculationOptions,
  type FqmCalculationResult,
  type FqmPopulationResult,
} from "@work-well/official-executor";

export const POPULATION_CODES = [
  "initial-population",
  "denominator",
  "denominator-exclusion",
  "numerator",
  // DENEXCEP is compared, not assumed absent (Codex, #358). CMS2 declares it alongside DENEX, and CMS68
  // declares it INSTEAD of DENEX — so omitting it meant CMS68's gate compared a population the measure
  // does not have while ignoring the one it does. A green 19/19 could coexist with broken exception
  // handling, which flows straight into the runtime EXCLUDED outcome and into MeasureReport/QRDA.
  // cms122/cms125 declare no exception, so both sides are 0 and their decks are unaffected.
  "denominator-exception",
] as const;
/** Short column labels, keyed by code so the header cannot drift from the compared vector. */
export const POPULATION_ABBREV: Record<(typeof POPULATION_CODES)[number], string> = {
  "initial-population": "IPP",
  denominator: "DENOM",
  "denominator-exclusion": "DENEX",
  numerator: "NUMER",
  "denominator-exception": "DENEXCEP",
};
const POPULATION_ABBREV_JOINED = POPULATION_CODES.map((c) => POPULATION_ABBREV[c]).join("/");

export type PopulationCode = (typeof POPULATION_CODES)[number];
export type PopulationCounts = Record<PopulationCode, number>;

const MEASURES = {
  cms122: {
    name: "CMS122FHIRDiabetesAssessGT9Pct",
    bundleFile: "CMS122FHIRDiabetesAssessGT9Pct-bundle.json",
  },
  cms125: {
    name: "CMS125FHIRBreastCancerScreen",
    bundleFile: "CMS125FHIRBreastCancerScreen-bundle.json",
  },
  cms2: {
    name: "CMS2FHIRPCSDepScreenAndFollowUp",
    bundleFile: "CMS2FHIRPCSDepScreenAndFollowUp-bundle.json",
  },
  cms68: {
    name: "CMS68FHIRDocumentationCurrentMeds",
    bundleFile: "CMS68FHIRDocumentationCurrentMeds-bundle.json",
  },
  cms951: {
    name: "CMS951FHIRKidneyHealthEval",
    bundleFile: "CMS951FHIRKidneyHealthEval-bundle.json",
  },
  // ADR-053. The last of the six M-A priority candidates to onboard, and the only one whose blocker was
  // a value set upstream does not ship at all (…3.526.3.1278 "Tobacco Use Screening" — 32 declared, 31
  // shipped). Sourced from VSAC at vendor time via `--complete-terminology`, which is a WEAKER
  // provenance than a completed cap: upstream shipped no codes to check containment against and
  // declared no total to check length against. The deck below is what licenses it — 47 cases with the
  // measure steward's own expected population vectors, which a wrong value set does not satisfy.
  cms138: {
    name: "CMS138FHIRTobaccoScrnCessation",
    bundleFile: "CMS138FHIRTobaccoScrnCessation-bundle.json",
  },
  // Vendored through the credentialed `vendor-official-measure.yml` workflow. Both arrived
  // terminology-COMPLETE (`truncated: []`, `absent: []`): VSAC resolved their capped
  // AdvancedIllness-class expansions during normal vendoring, with no absent value set like CMS138
  // needed and no `measure-bundle+sourced-supplement` caveat. Their provenance is full
  // `measure-bundle`, the same as CMS122, CMS125, CMS2, CMS68, and CMS951.
  cms130: {
    name: "CMS130FHIRColorectalCancerScrn",
    bundleFile: "CMS130FHIRColorectalCancerScrn-bundle.json",
  },
  cms165: {
    name: "CMS165FHIRControllingHighBP",
    bundleFile: "CMS165FHIRControllingHighBP-bundle.json",
  },
};

/**
 * Derived from the map rather than hand-listed, so adding a measure cannot leave the two out of step —
 * the previous union had to be edited in a second place and a mismatch was a compile error at best and a
 * silently ungated measure at worst.
 */
export type OfficialMeasureId = keyof typeof MEASURES;

/**
 * The measures covered by the official MADiE test-case gate (roadmap §7.4 PR-6). THE RULE: a measure
 * may not enter `WORKWELL_OFFICIAL_MEASURES` until this gate is green for it, so this set must stay
 * identical to the vendored artifact set — `official-gate.test.ts` enforces that, in the default suite.
 */
export const OFFICIAL_GATED_MEASURES: readonly OfficialMeasureId[] = Object.keys(
  MEASURES,
) as OfficialMeasureId[];

/** The upstream measure name the harness locates the fetched bundle by. Pinned to the manifest. */
export function officialMeasureName(catalogId: string): string | undefined {
  return MEASURES[catalogId as OfficialMeasureId]?.name;
}

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
    "denominator-exception": 0,
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

// Re-exported from the package rather than redeclared: a local copy is exactly the drift the
// extraction exists to prevent.
export type { FqmPopulationResult };

interface FqmExecutionResult {
  patientId?: string;
  evaluatedResource?: FhirResource[];
  detailedResults?: Array<{
    populationResults?: FqmPopulationResult[];
    /** Named per-statement results. PR-7 persists these as `evidence_json.official`, so the reduction
     *  check counts them — otherwise "stripping keeps statement results" is prose nothing enforces. */
    statementResults?: Array<{ statementName?: string; libraryName?: string }>;
  }>;
}

interface FqmOutput {
  results?: FqmExecutionResult[];
  withErrors?: unknown[];
}

// Re-exported from the package rather than redeclared - a local copy is exactly the drift the
// extraction exists to prevent.
export type { FqmCalculationOptions };

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
  /**
   * `measure-bundle` — every value set the ELM declares came from UPSTREAM's own bundle. That is what
   * makes this gate an EXTERNAL check: their artifact, their terminology, their expected vectors.
   *
   * `measure-bundle+sourced-supplement` — all of that, EXCEPT for the OIDs in `supplementedOids`,
   * which upstream's bundle does not ship at all and which came from our vendored sidecar instead
   * (ADR-053). A weaker claim, and it must never be blended into the headline number: for those value
   * sets the CODES are ours. What stays upstream's is the answer key — the expected population vectors
   * — which is why a green deck is still real evidence that the sourced codes are right.
   */
  valueSetMode: OfficialValueSetMode;
  /** Bare OIDs taken from the sidecar because the bundle ships no ValueSet for them. Usually empty. */
  supplementedOids: string[];
  trustMetaProfile: boolean;
  profileRetry: boolean;
  retrieveSignal: boolean;
  engineWarnings: number;
  calculationError?: string;
  cases: OfficialCaseResult[];
  summary: OfficialRunSummary;
  draftDrift?: Cms122DraftDrift;
}

/**
 * The option block + the fqm#371 date-only period-end fix are owned by `@work-well/official-executor`
 * so the MADiE harness and the live literal diff can never drift apart on them.
 */
function calculationOptions(period: MeasurementPeriod, trustMetaProfile: boolean): FqmCalculationOptions {
  return officialCalculationOptions(period, { trustMetaProfile });
}

function hasRetrieveSignal(output: FqmOutput): boolean {
  return officialHasRetrieveSignal(output as FqmCalculationResult);
}

function actualPopulationCounts(populations: FqmPopulationResult[]): PopulationCounts {
  const actual: PopulationCounts = {
    "initial-population": 0,
    denominator: 0,
    "denominator-exclusion": 0,
    numerator: 0,
    "denominator-exception": 0,
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

export type OfficialValueSetMode = "measure-bundle" | "measure-bundle+sourced-supplement";

export interface RunOfficialMeasureOptions {
  calculate?: FqmCalculate;
  /**
   * Terminology to fall back on for value sets the measure Bundle does NOT ship (ADR-053).
   *
   * Pass the artifact's whole runtime cache; this function narrows it (see `supplementFor`). The gate's
   * value comes from executing upstream's artifact against upstream's terminology, so anything that
   * could quietly substitute ours for theirs destroys the thing being measured.
   */
  supplementalValueSets?: unknown[];
}

/**
 * The value sets to hand fqm as an external cache: ONLY those the bundle does not ship.
 *
 * ## Why this filters rather than trusting its caller
 *
 * The caller has the artifact's entire runtime terminology to hand, and passing all of it would be the
 * natural thing to do. It would also silently convert this gate from "upstream's terminology" into
 * "ours", for every measure, in a way no assertion here would notice — the deck would still be green
 * and would no longer mean what the report says it means.
 *
 * So the narrowing happens HERE, next to the `calculate` call it protects, and the OIDs that survive
 * are recorded on the run and rendered in the report. `supplementedOids` being empty is the normal
 * case and the strong one.
 *
 * Compared on the bare OID because a canonical may carry a `|version` suffix the shipped
 * `ValueSet.url` does not (review of #364).
 */
export function supplementFor(
  loaded: Pick<LoadedOfficialMeasure, "valueSetResources">,
  supplemental: unknown[] | undefined,
): unknown[] {
  if (!supplemental || supplemental.length === 0) return [];
  const oidOf = (url: unknown): string => {
    const raw = typeof url === "string" ? url : "";
    const marker = "/ValueSet/";
    const tail = raw.includes(marker) ? raw.slice(raw.lastIndexOf(marker) + marker.length) : raw;
    const pipe = tail.indexOf("|");
    return pipe === -1 ? tail : tail.slice(0, pipe);
  };
  const shipped = new Set(
    loaded.valueSetResources.map((resource) => oidOf((resource as { url?: unknown }).url)),
  );
  return supplemental.filter((resource) => {
    const oid = oidOf((resource as { url?: unknown }).url);
    return oid !== "" && !shipped.has(oid);
  });
}

/** Execute all valid cases for one measure in a single fqm-execution batch. */
export async function runOfficialMeasureCases(
  loaded: LoadedOfficialMeasure,
  options: RunOfficialMeasureOptions = {},
): Promise<OfficialMeasureRun> {
  const calculate: FqmCalculate =
    options.calculate ?? ((await loadCalculator()) as unknown as FqmCalculate);
  const validCases = loaded.cases.filter(
    (item): item is OfficialCase & Required<Pick<OfficialCase, "patientId" | "patientBundle" | "expected">> =>
      !item.loadError && !!item.patientId && !!item.patientBundle && !!item.expected,
  );

  // Narrowed to the value sets upstream does not ship — usually none, in which case `calculate` is
  // invoked with THREE arguments exactly as before, so the default path is byte-identical and the
  // "upstream's terminology" claim is untouched for every measure that does not need this.
  const supplement = supplementFor(loaded, options.supplementalValueSets);
  const supplementedOids = supplement.map((resource) => String((resource as { url?: unknown }).url ?? ""));
  const valueSetMode: OfficialValueSetMode =
    supplement.length > 0 ? "measure-bundle+sourced-supplement" : "measure-bundle";
  // Spread, not a positional `undefined`: fqm's 4th parameter is optional and passing an explicit
  // `undefined` is not the same call. The existing test asserts a 3-argument invocation on the default
  // path, which is the property that keeps this change inert for the five complete measures.
  const cacheArg: [unknown[]] | [] = supplement.length > 0 ? [supplement] : [];

  let output: FqmOutput;
  let trustMetaProfile = false;
  let profileRetry = false;
  try {
    output = await calculate(
      loaded.measureBundle,
      validCases.map((item) => item.patientBundle),
      calculationOptions(loaded.measurementPeriod, false),
      ...cacheArg,
    );
    if (!hasRetrieveSignal(output) && validCases.length > 0) {
      profileRetry = true;
      trustMetaProfile = true;
      output = await calculate(
        loaded.measureBundle,
        validCases.map((item) => item.patientBundle),
        calculationOptions(loaded.measurementPeriod, true),
        ...cacheArg,
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
      valueSetMode,
      supplementedOids,
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
    valueSetMode,
    supplementedOids,
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

/**
 * Which artifact bytes the reduction check actually executed. Without this the report proves only
 * "some v1.0.000 artifact was neutral" — and every reduction setting produces a v1.0.000 artifact, so
 * a re-vendor at different settings would leave the committed evidence byte-identical and CI green.
 * The SHA-256 is over the file as it sits on disk, so it is a fact about the bytes rather than a claim
 * the manifest makes about itself.
 */
export interface ReductionArtifactIdentity {
  sha256: string;
  vendoredBytes: number;
  /** Undefined when no manifest corroborates these exact bytes — reported as "unverified", never as a
   *  positive claim in either direction. */
  strippedElmAnnotations?: boolean;
}

/**
 * Which terminology the reduced artifact was executed with.
 *
 * `vendored-terminology-sidecar` is the one that makes this check evidence about PRODUCTION: it is the
 * artifact's own `terminology.json`, expanded through the same `expandArtifactTerminology` the router
 * uses. `official-v1-bundle-cache` re-uses the UPSTREAM bundle's ValueSets, which proves the reduction
 * is neutral but says nothing about the terminology the runtime would actually load — that gap is
 * exactly what PR-8a existed to close, so it is recorded rather than assumed.
 */
export type DriftValueSetMode = "official-v1-bundle-cache" | "vendored-terminology-sidecar";

export interface Cms122DraftDrift {
  artifactVersion: string;
  artifact?: ReductionArtifactIdentity;
  valueSetMode: DriftValueSetMode;
  valueSetModeReason?: string;
  /** Named statement results the VENDORED artifact produced for the WORST subject (0 if the run errored). */
  namedStatementResults: number;
  total: number;
  changedCases: number;
  errors: number;
  cases: DraftDriftCase[];
}

export interface RunDraftDriftOptions {
  calculate?: FqmCalculate;
  artifact?: ReductionArtifactIdentity;
  /**
   * The terminology to execute the reduced artifact with. Supply the RUNTIME's — the vendored
   * `terminology.json`, built through `expandArtifactTerminology` — and this check stops being a
   * statement about bundle reduction alone and becomes a statement about the whole production
   * configuration: our artifact, our terminology, against upstream's artifact and upstream's
   * terminology, over every official test case.
   *
   * Omitted, it falls back to the upstream bundle's own ValueSets, which is what it did before PR-8a.
   */
  valueSetCache?: unknown[];
  valueSetMode?: DriftValueSetMode;
  /**
   * Why the runtime terminology was unavailable, when it was. Recorded verbatim in the report because
   * three unlike causes reach the fallback — sidecar absent, hash mismatch, and a canonical the ELM
   * needs but the sidecar lacks — and asserting the first one for all three made the report state a
   * file was missing while it sat on disk.
   */
  valueSetModeReason?: string;
}

/**
 * Compare the upstream measure bundle against OUR vendored, reduced artifact at the SAME version, using
 * the upstream ValueSets for both. Formerly this measured drift from a stale v0.5.000 draft; since PR-5
 * vendored v1.0.000 it proves something more useful - that dropping CQL, ELM XML, narratives and
 * ValueSets during vendoring changes no population result.
 */
export async function runCms122DraftDrift(
  loaded: LoadedOfficialMeasure,
  officialRun: OfficialMeasureRun,
  draftBundle: FhirBundle,
  options: RunDraftDriftOptions = {},
): Promise<Cms122DraftDrift> {
  if (loaded.measure !== officialRun.measure) {
    throw new Error(
      `reduction drift requires a matching load and run (got ${loaded.measure} vs ${officialRun.measure})`,
    );
  }
  const calculate: FqmCalculate =
    options.calculate ?? ((await loadCalculator()) as unknown as FqmCalculate);
  const validCases = loaded.cases.filter(
    (item): item is OfficialCase & Required<Pick<OfficialCase, "patientId" | "patientBundle">> =>
      !item.loadError && !!item.patientId && !!item.patientBundle,
  );
  const measure = draftBundle.entry.map((entry) => entry.resource).find((resource) => resource.resourceType === "Measure");
  const artifactVersion = typeof measure?.version === "string" ? measure.version : "unknown";
  const valueSetCache = options.valueSetCache ?? loaded.valueSetResources;
  const valueSetMode: DriftValueSetMode =
    options.valueSetMode ?? (options.valueSetCache ? "vendored-terminology-sidecar" : "official-v1-bundle-cache");
  const modeReason = options.valueSetCache ? undefined : options.valueSetModeReason;

  let output: FqmOutput;
  try {
    output = await calculate(
      draftBundle,
      validCases.map((item) => item.patientBundle),
      calculationOptions(loaded.measurementPeriod, officialRun.trustMetaProfile),
      valueSetCache,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cases = validCases.map((item) => ({ uuid: item.uuid, name: item.name, differences: [], error: message }));
    return {
      artifactVersion,
      ...(options.artifact ? { artifact: options.artifact } : {}),
      valueSetMode,
      ...(modeReason ? { valueSetModeReason: modeReason } : {}),
      namedStatementResults: 0,
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
        error: !official ? "official v1 result unavailable" : "vendored-artifact result unavailable",
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
  // PR-7 persists fqm's named statement results as `evidence_json.official`. Stripping ELM annotations
  // removes `localId`, and it would be easy to assume the statements go with them — so count them here
  // rather than leave "statement results survive" as a sentence in a README that nothing checks.
  // The count PR-7 cares about is how many named results ONE subject's evaluation yields, since that is
  // what becomes that subject's `evidence_json.official`. Deliberately not a de-duplicated union across
  // subjects: these measures include 9-10 libraries that reuse statement names, so any dedupe rule
  // undercounts (138 by bare name, 150 by library-qualified name) and records a number that means
  // something other than what it says.
  //
  // The MINIMUM across subjects, not the maximum: a max lets one subject with an empty payload hide
  // behind fifty-four healthy ones, leaving the report's floor green while PR-7 would persist nothing
  // for that subject. Subjects with no `detailedResults` at all are excluded because the population
  // comparison already fails them ("vendored-artifact result unavailable" -> errors -> exit 1).
  const perSubjectStatements = (output.results ?? [])
    .filter((result) => result.detailedResults?.[0])
    .map(
      (result) =>
        (result.detailedResults?.[0]?.statementResults ?? []).filter(
          (statement) => typeof statement.statementName === "string",
        ).length,
    );
  const statementResults = perSubjectStatements.length > 0 ? Math.min(...perSubjectStatements) : 0;
  return {
    artifactVersion,
    ...(options.artifact ? { artifact: options.artifact } : {}),
    valueSetMode,
    ...(modeReason ? { valueSetModeReason: modeReason } : {}),
    namedStatementResults: statementResults,
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
    "pnpm test:official-cases [--measure <catalogId>] [--content-dir <path>]",
    "# If pnpm is not directly on PATH: corepack pnpm test:official-cases",
    "```",
    "",
    "The fetch script sparse-checks out only the gated measures' bundles and test-case trees into ignored `.official-content/`; it refuses to overwrite an unrelated non-Git directory.",
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
    "`fqm-execution` 1.8.5 reads ValueSet resources from the measure Bundle before adding any optional external cache. ValueSets are consumed directly from each official measure Bundle; no VSAC network call is made during this run. **One exception, flagged per measure below:** where an upstream bundle ships no ValueSet resource at all for a value set its ELM declares, that one is supplied from WorkWell's vendored terminology sidecar (ADR-053) — vendored earlier from VSAC at a pinned release, never fetched here. Measures with no such line ran entirely on upstream's terminology.",
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
    // Rendered right under the measure's own line, not in a footnote: a supplemented run means the
    // headline number for THIS measure is not the same kind of evidence as the others', and the report
    // is the thing people quote. Naming the OIDs matters too — "1 value set" invites the reader to
    // assume it is minor, and whether it is depends entirely on which one.
    if (run.supplementedOids.length > 0) {
      lines.push(
        `  - **Terminology supplement (ADR-053):** ${run.supplementedOids.length} value set(s) came from ` +
          `WorkWell's vendored sidecar because the upstream bundle ships no ValueSet resource for them — ` +
          run.supplementedOids.map((oid) => `\`${oid}\``).join(", ") +
          `. Everything else is upstream's own terminology. **This is a weaker claim than the other ` +
          `measures carry:** for these value sets the CODES are ours (sourced from VSAC at the pinned ` +
          `release). What remains upstream's is the ANSWER KEY — the expected population vectors — which ` +
          `is why agreement here is still real evidence that the sourced codes are right, and is not ` +
          `evidence about upstream's terminology.`,
      );
    }
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
      // Columns are DERIVED from the compared vector, not hand-listed. They diverged once: DENEXCEP was
      // added to `POPULATION_CODES` and the table kept rendering four columns, so the population that
      // *defines* a case named "DENEXCEPPass…" was invisible — and CMS68's DENEX column reported a
      // population that measure does not even declare (review, #358). A report that hides the column it
      // compares invites the opposite conclusion from the evidence.
      `| Case | UUID | ${POPULATION_CODES.map((c) => `${POPULATION_ABBREV[c]} E/A`).join(" | ")} | Result |`,
      `|---|---|${POPULATION_CODES.map(() => "---:").join("|")}|---|`,
    );
    for (const item of run.cases) {
      lines.push(
        `| ${escapeMarkdown(item.name)} | \`${item.uuid}\` | ` +
          `${POPULATION_CODES.map((code) => populationCell(item, code)).join(" | ")} | ${resultLabel(item)} |`,
      );
    }
    if (run.draftDrift) {
      lines.push(
        "",
        `### ${run.measure.toUpperCase()} reduction check — upstream bundle vs vendored artifact v${run.draftDrift.artifactVersion}`,
        "",
        run.draftDrift.valueSetMode === "vendored-terminology-sidecar"
          ? `Executed with the RUNTIME configuration — our reduced artifact plus its own vendored ` +
            `terminology sidecar, expanded through the same code path production uses — against the ` +
            `upstream bundle and upstream ValueSets. ${run.draftDrift.changedCases}/${run.draftDrift.total} ` +
            `cases changed population vector; ${run.draftDrift.errors} drift errors.`
          : `DOWNGRADED to the official v1 Bundle ValueSets as the external cache: this run does NOT ` +
            `exercise the runtime's terminology. Reason: ` +
            `${escapeMarkdown(run.draftDrift.valueSetModeReason ?? "runtime terminology unavailable")}. ` +
            `${run.draftDrift.changedCases}/${run.draftDrift.total} cases ` +
            `changed population vector; ${run.draftDrift.errors} drift errors.`,
        "",
        ...(run.draftDrift.artifact
          ? [
              `Artifact proven: \`${run.draftDrift.artifact.sha256}\` ` +
                `(${(run.draftDrift.artifact.vendoredBytes / 1e6).toFixed(1)} MB, ELM annotations ` +
                `${
                  run.draftDrift.artifact.strippedElmAnnotations === undefined
                    ? "unverified"
                    : run.draftDrift.artifact.strippedElmAnnotations
                      ? "stripped"
                      : "retained"
                }). Compared on population membership ` +
                `(${POPULATION_CODES.join("/")}) only; the artifact also returned ` +
                `${run.draftDrift.namedStatementResults} named statement results for every subject.`,
              "",
            ]
          : []),
        // Header derived for the same reason: the row is built with `POPULATION_CODES.map(...)`, so a
        // hand-written label list silently under-describes it the moment the vector grows.
        `| Case | UUID | Changed populations | v1 ${POPULATION_ABBREV_JOINED} | draft ${POPULATION_ABBREV_JOINED} |`,
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
