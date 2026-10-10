/**
 * Edit cases (#779): hand-built synthetic patients that DISCRIMINATE a WorkWell translation's logic edit
 * from CMS's logic, read from `measures/derived/<id>/edit-cases.json` by `derived:check --madie` and by
 * nothing else — never by the corpus, ingest or the runtime.
 *
 * Why they exist: CMS's own decks need not exercise an edit. On CMS130v15's look-back edit neither the
 * MADiE deck nor the Cypress deck moves a population, so a translation whose edit was lost (or reverted)
 * would pass both. An edit case states, for one patient, what CMS's logic answers AND what the
 * translation's answers, and the check runs it through both. A set in which no case's two answers differ
 * proves nothing about the edit, so the check refuses it.
 *
 * Both runs use CMS's upstream bundle's own value sets and the MADiE deck's measurement period, so the
 * only thing that differs between them is the logic. The one addition is on the TRANSLATION's side only:
 * a value set the translation's logic declares and CMS's upstream bundle ships no ValueSet for (CMS125v15's
 * "Unilateral Mastectomy", 1285, absent from CMS's 2026 terminology) would make fqm refuse every run, so
 * the file's optional `supplementalValueSets` states, per such value set's canonical URL, the codes the
 * translation's run expands it to. `derived:check` requires its keys to be exactly the set the translation
 * declares and upstream lacks, and (under `--record`) each code to be in the translation's own sidecar
 * expansion. CMS's side never gets a supplement, and a supplement never stands in for a value set upstream
 * ships (the harness's `supplementFor` narrows to the ones it lacks; the runner checks nothing was dropped).
 * Every population the Measure declares must be stated for every rate: an omitted population would be
 * compared as 0 and read as a claim nobody made.
 *
 * Prints nothing itself. A patient here is synthetic, but the runner still reports cases by id and
 * populations as counts, never resource content.
 */
import {
  POPULATION_ABBREV,
  POPULATION_CODES,
  type FhirBundle,
  type FhirResource,
  type LoadedOfficialMeasure,
  type MeasurementPeriod,
  type OfficialCase,
  type OfficialCaseResult,
  type OfficialMeasureRun,
  type PopulationCode,
  type PopulationCounts,
  type RunOfficialMeasureOptions,
} from "./official-cases.ts";

export const EDIT_CASES_FILE = "edit-cases.json";

/** The two logics an edit case states an answer for. */
export type EditCaseSide = "cms" | "translation";
export const EDIT_CASE_SIDES: readonly EditCaseSide[] = ["cms", "translation"];

export interface EditCase {
  id: string;
  description: string;
  /** The one Patient's id: fqm keys every result by it, so it is unique across the set. */
  patientId: string;
  resources: FhirResource[];
  /** One vector per rate, in the Measure's group order; undeclared populations are 0. */
  expected: Record<EditCaseSide, PopulationCounts[]>;
}

/** One code of a supplemental value set's expansion. */
export interface SupplementCode {
  system: string;
  code: string;
}

export interface EditCaseSet {
  measurementPeriod: MeasurementPeriod;
  cases: EditCase[];
  /**
   * Translation side only: value-set canonical URL → the codes its expansion holds, for the value sets the
   * translation declares and CMS's upstream bundle lacks. Absent when the file states none.
   */
  supplementalValueSets?: Record<string, SupplementCode[]>;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Refuse a key the format does not have: a misspelt `expectd` must not be read as "no expectation". */
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${where} has unknown key(s) ${unknown.join(", ")} (allowed: ${allowed.join(", ")})`);
}

/**
 * The populations each group of the bundle's Measure declares, in group order, restricted to the five the
 * MADiE harness compares. CMS130 declares four; a measure with a denominator exception declares five.
 */
export function declaredPopulations(measureBundle: Pick<FhirBundle, "entry">): PopulationCode[][] {
  const measure = measureBundle.entry.map((e) => e.resource).find((r) => r.resourceType === "Measure");
  if (!measure) throw new Error("the measure bundle has no Measure");
  const groups = Array.isArray(measure["group"]) ? (measure["group"] as Array<Record<string, unknown>>) : [];
  if (groups.length === 0) throw new Error("the Measure declares no group");
  return groups.map((group, index) => {
    const codes = (Array.isArray(group["population"]) ? (group["population"] as Array<Record<string, unknown>>) : [])
      .map((p) => ((p["code"] as { coding?: Array<{ code?: unknown }> } | undefined)?.coding ?? []).map((c) => c.code).find((c) => POPULATION_CODES.includes(c as PopulationCode)))
      .filter((c): c is PopulationCode => c !== undefined);
    if (codes.length === 0) throw new Error(`the Measure's group ${index + 1} declares no population the harness compares`);
    return POPULATION_CODES.filter((code) => codes.includes(code));
  });
}

function parseRate(value: unknown, declared: readonly PopulationCode[], where: string): PopulationCounts {
  if (!isObject(value)) throw new Error(`${where} is not an object of population counts`);
  onlyKeys(value, declared, where);
  const counts: PopulationCounts = { "initial-population": 0, denominator: 0, "denominator-exclusion": 0, numerator: 0, "denominator-exception": 0 };
  for (const code of declared) {
    const count = value[code];
    // Patient-based measures: a patient is in a population or not. Anything else is a typo, not a count.
    if (count !== 0 && count !== 1) throw new Error(`${where} must state ${code} as 0 or 1 (every population the Measure declares: ${declared.join(", ")})`);
    counts[code] = count;
  }
  return counts;
}

function parseRates(value: unknown, populations: readonly (readonly PopulationCode[])[], where: string): PopulationCounts[] {
  // One rate may be written as a bare object; several must be an array, one per group, in group order.
  const rates = Array.isArray(value) ? value : populations.length === 1 ? [value] : null;
  if (!rates) throw new Error(`${where} must be an array of ${populations.length} rates, one per Measure group`);
  if (rates.length !== populations.length) throw new Error(`${where} states ${rates.length} rate(s); the Measure has ${populations.length}`);
  return rates.map((rate, i) => parseRate(rate, populations[i]!, populations.length === 1 ? where : `${where}[${i}]`));
}

/**
 * `supplementalValueSets`: an object of value-set canonical URL → a non-empty list of `{ system, code }`.
 * An empty list is refused: it would supply a value set that matches nothing, which is what the deck's
 * empty supplement already is — an edit case states codes because it needs them to match.
 */
function parseSupplement(value: unknown): Record<string, SupplementCode[]> {
  const where = "supplementalValueSets";
  if (!isObject(value)) throw new Error(`${where} must be an object of value-set canonical URL → [{ system, code }]`);
  const out: Record<string, SupplementCode[]> = {};
  for (const [url, codes] of Object.entries(value)) {
    if (!/^https?:\/\/\S+\/ValueSet\/[^/|\s]+$/.test(url)) throw new Error(`${where} key '${url}' is not a value-set canonical URL (…/ValueSet/<id>, no |version)`);
    if (!Array.isArray(codes) || codes.length === 0) throw new Error(`${where}['${url}'] must be a non-empty array of { system, code }`);
    const seen = new Set<string>();
    out[url] = codes.map((raw, i) => {
      const at = `${where}['${url}'][${i}]`;
      if (!isObject(raw)) throw new Error(`${at} is not an object`);
      onlyKeys(raw, ["system", "code"], at);
      if (!isText(raw["system"]) || !isText(raw["code"])) throw new Error(`${at} needs a system and a code`);
      const key = `${raw["system"]}|${raw["code"]}`;
      if (seen.has(key)) throw new Error(`${at} repeats ${key}`);
      seen.add(key);
      return { system: raw["system"], code: raw["code"] };
    });
  }
  return out;
}

/**
 * Why a set's `supplementalValueSets` is not the one the translation needs: its keys must be EXACTLY
 * `required` — the value sets the translation declares and CMS's upstream bundle lacks — compared as exact
 * strings, as fqm compares them. A missing key would leave the translation's run refused by fqm; an extra
 * one would stand in for a value set nothing needs supplying.
 */
export function supplementProblems(set: EditCaseSet, required: readonly string[]): string[] {
  const stated = Object.keys(set.supplementalValueSets ?? {});
  const missing = required.filter((url) => !stated.includes(url)).sort();
  const extra = stated.filter((url) => !required.includes(url)).sort();
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`supplementalValueSets states no codes for ${missing.length} value set(s) the translation declares and CMS's upstream bundle lacks: ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`supplementalValueSets names ${extra.length} value set(s) that are not ones the translation declares and CMS's upstream bundle lacks: ${extra.join(", ")}`);
  return problems;
}

/** The set's supplement as fqm's value-set cache: one ValueSet per URL, its codes as the expansion. */
export function supplementValueSets(set: EditCaseSet): unknown[] {
  return Object.entries(set.supplementalValueSets ?? {}).map(([url, codes]) => valueSetExpansion(url, codes));
}

/**
 * A ValueSet resource with `codes` as its expansion — the shape fqm reads from its value-set cache (the
 * same `buildValueSetCache` emits). `id` is the bare id after `/ValueSet/`.
 */
export function valueSetExpansion(url: string, codes: readonly SupplementCode[]): Record<string, unknown> {
  return {
    resourceType: "ValueSet",
    id: url.slice(url.lastIndexOf("/") + 1),
    url,
    status: "active",
    expansion: { timestamp: "2026-01-01T00:00:00Z", contains: codes.map((c) => ({ system: c.system, code: c.code })) },
  };
}

/**
 * Read an `edit-cases.json`. Strict on purpose — an unknown key, a missing population, a second Patient,
 * a duplicated case or patient id each refuse the whole file, because each would otherwise run as a case
 * that says less than it appears to.
 */
export function parseEditCases(json: unknown, populations: readonly (readonly PopulationCode[])[]): EditCaseSet {
  if (!isObject(json)) throw new Error("edit-cases.json is not a JSON object");
  onlyKeys(json, ["measurementPeriod", "cases", "supplementalValueSets"], "edit-cases.json");
  const supplement = "supplementalValueSets" in json ? parseSupplement(json["supplementalValueSets"]) : undefined;
  const period = json["measurementPeriod"];
  if (!isObject(period) || !isText(period["start"]) || !isText(period["end"])) {
    throw new Error("edit-cases.json needs measurementPeriod { start, end }");
  }
  onlyKeys(period, ["start", "end"], "measurementPeriod");
  if (!Array.isArray(json["cases"])) throw new Error("edit-cases.json needs a cases array");
  const ids = new Set<string>();
  const patientIds = new Set<string>();
  const cases = (json["cases"] as unknown[]).map((raw, index): EditCase => {
    if (!isObject(raw)) throw new Error(`case ${index + 1} is not an object`);
    if (!isText(raw["id"])) throw new Error(`case ${index + 1} has no id`);
    const id = raw["id"];
    const where = `case ${id}`;
    onlyKeys(raw, ["id", "description", "resources", "expected"], where);
    if (ids.has(id)) throw new Error(`${where} appears twice`);
    ids.add(id);
    if (!isText(raw["description"])) throw new Error(`${where} has no description`);
    const resources = raw["resources"];
    if (!Array.isArray(resources) || resources.length === 0) throw new Error(`${where} has no resources`);
    for (const [i, resource] of resources.entries()) {
      if (!isObject(resource) || !isText(resource["resourceType"])) throw new Error(`${where} resource ${i + 1} has no resourceType`);
    }
    const patients = (resources as FhirResource[]).filter((r) => r.resourceType === "Patient");
    if (patients.length !== 1 || !isText(patients[0]!.id)) throw new Error(`${where} needs exactly one Patient with an id, found ${patients.length}`);
    const patientId = patients[0]!.id!;
    if (patientIds.has(patientId)) throw new Error(`${where} reuses Patient ${patientId}; fqm keys results by patient, so each case needs its own`);
    patientIds.add(patientId);
    const expected = raw["expected"];
    if (!isObject(expected)) throw new Error(`${where} has no expected { cms, translation }`);
    onlyKeys(expected, EDIT_CASE_SIDES, `${where} expected`);
    return {
      id,
      description: raw["description"],
      patientId,
      resources: resources as FhirResource[],
      expected: {
        cms: parseRates(expected["cms"], populations, `${where} expected.cms`),
        translation: parseRates(expected["translation"], populations, `${where} expected.translation`),
      },
    };
  });
  return { measurementPeriod: { start: period["start"], end: period["end"] }, cases, ...(supplement ? { supplementalValueSets: supplement } : {}) };
}

const vector = (rates: readonly PopulationCounts[]): string => JSON.stringify(rates.map((r) => POPULATION_CODES.map((c) => r[c])));

/** The cases whose two expectations differ: the only ones that say anything about the edit. */
export const discriminatingCases = (set: EditCaseSet): EditCase[] => set.cases.filter((c) => vector(c.expected.cms) !== vector(c.expected.translation));

/**
 * The set as the MADiE harness's cases, with ONE side's expectations. Each list gets its own copy of the
 * resources, so nothing one run does to a bundle can reach the other.
 */
export function officialCasesFor(set: EditCaseSet, side: EditCaseSide): OfficialCase[] {
  return set.cases.map((c) => ({
    uuid: c.id,
    name: c.id,
    title: c.description,
    series: "WorkWell edit case",
    description: c.description,
    patientId: c.patientId,
    patientBundle: { resourceType: "Bundle", type: "collection", entry: structuredClone(c.resources).map((resource) => ({ resource })) },
    expected: c.expected[side][0]!,
    expectedRates: c.expected[side],
  }));
}

/** e.g. "IPP 1 DENOM 1 DENEX 0 NUMER 0", only the populations the Measure declares, rates joined by " | ". */
export function renderRates(rates: readonly PopulationCounts[] | undefined, populations: readonly (readonly PopulationCode[])[]): string {
  if (!rates || rates.length === 0) return "no result";
  return rates.map((rate, i) => (populations[i] ?? POPULATION_CODES).map((code) => `${POPULATION_ABBREV[code]} ${rate[code]}`).join(" ")).join(" | ");
}

export interface EditCaseSideResult {
  side: EditCaseSide;
  total: number;
  /** Cases whose result is an `expected-agreement` with this side's stated answer. */
  agreeing: number;
  /** One line per case that did not agree: its id, what was expected and what came back. Counts only. */
  disagreements: string[];
}

export interface EditCaseOutcome {
  total: number;
  discriminating: number;
  sides: EditCaseSideResult[];
  problems: string[];
}

type RunCases = (loaded: LoadedOfficialMeasure, options?: RunOfficialMeasureOptions) => Promise<OfficialMeasureRun>;

/**
 * What makes a set unable to test an edit, before anything runs: no case; no case whose two answers
 * differ (it would pass with the edit lost); and a period that is not the deck's (the file's answers were
 * worked out for its own period — run at another, a look-back boundary case tests nothing).
 */
export function editCaseSetProblems(set: EditCaseSet, deckPeriod: MeasurementPeriod): string[] {
  const problems: string[] = [];
  if (set.cases.length === 0) problems.push("edit-cases.json holds no case");
  else if (discriminatingCases(set).length === 0) {
    problems.push(`none of the ${set.cases.length} edit case(s) expects a different answer from the translation than from CMS's logic, so none tests the edit`);
  }
  if (deckPeriod.start !== set.measurementPeriod.start || deckPeriod.end !== set.measurementPeriod.end) {
    problems.push(`edit-cases.json is written for ${set.measurementPeriod.start}..${set.measurementPeriod.end}, but the MADiE deck runs ${deckPeriod.start}..${deckPeriod.end}`);
  }
  return problems;
}

/**
 * Run the set on CMS's logic (`upstreamBundle`) with CMS's expectations and on the translation's
 * (`translatedBundle`) with the translation's, each over `loaded`'s own value sets and period — the
 * translation's side plus the set's `supplementalValueSets`, which the harness must then report having
 * supplemented, every one (CMS's side: none). Whether those are the RIGHT value sets is the caller's
 * check (`supplementProblems`), made before this runs.
 *
 * Nothing runs for a set `editCaseSetProblems` refuses. After the runs, every case must come back exactly
 * once with an `expected-agreement` on BOTH sides — counted, not assumed, because the harness silently
 * returns a case it could not score with no agreement at all.
 */
export async function runEditCases(input: {
  set: EditCaseSet;
  loaded: LoadedOfficialMeasure;
  upstreamBundle: FhirBundle;
  translatedBundle: FhirBundle;
  runCases: RunCases;
}): Promise<EditCaseOutcome> {
  const { set, loaded } = input;
  const total = set.cases.length;
  const discriminating = discriminatingCases(set).length;
  const problems = editCaseSetProblems(set, loaded.measurementPeriod);
  if (problems.length > 0) return { total, discriminating, sides: [], problems };

  const populations = declaredPopulations(input.upstreamBundle);
  const sides: EditCaseSideResult[] = [];
  const profile: boolean[] = [];
  // The translation's side alone gets the file's supplement; the option is left off entirely when there
  // is none, so the CMS side's call (and a translation that needs none) is exactly as it was.
  const supplement = supplementValueSets(set);
  const supplied = Object.keys(set.supplementalValueSets ?? {}).sort();
  for (const side of EDIT_CASE_SIDES) {
    const options: RunOfficialMeasureOptions = side === "translation" && supplement.length > 0 ? { supplementalValueSets: supplement } : {};
    const run = await input.runCases({ ...loaded, measureBundle: side === "cms" ? input.upstreamBundle : input.translatedBundle, cases: officialCasesFor(set, side) }, options);
    profile.push(run.trustMetaProfile);
    const label = side === "cms" ? "CMS's logic" : "the translation";
    // What the harness actually supplemented must be every value set the file states (it narrows away
    // any upstream ships), and on CMS's side nothing.
    const used = [...run.supplementedOids].sort();
    const want = side === "translation" ? supplied : [];
    if (JSON.stringify(used) !== JSON.stringify(want)) {
      problems.push(`${label}: the harness supplemented [${used.join(", ")}], expected [${want.join(", ")}]`);
    }
    if (run.calculationError) problems.push(`${label}: calculation error: ${run.calculationError}`);
    if (run.cases.length !== total) problems.push(`${label}: ${run.cases.length} case result(s) for ${total} edit case(s)`);
    const byId = new Map<string, OfficialCaseResult[]>();
    for (const result of run.cases) byId.set(result.uuid, [...(byId.get(result.uuid) ?? []), result]);
    const disagreements: string[] = [];
    let agreeing = 0;
    for (const c of set.cases) {
      const results = byId.get(c.id) ?? [];
      const result = results.length === 1 ? results[0]! : undefined;
      if (result?.agreement?.status === "expected-agreement") {
        agreeing++;
        continue;
      }
      const why = results.length !== 1 ? `${results.length} results` : result?.error ?? result?.loadError ?? (result?.agreement ? `got ${renderRates(result.actualRates, populations)}` : "not scored (no agreement)");
      disagreements.push(`edit case ${c.id} on ${label}: expected ${renderRates(c.expected[side], populations)}; ${why}`);
    }
    if (agreeing !== total) problems.push(`${label}: ${agreeing}/${total} edit case(s) agree`);
    sides.push({ side, total, agreeing, disagreements });
  }
  if (profile[0] !== profile[1]) problems.push("the profile retry ran on one side only");
  return { total, discriminating, sides, problems };
}
