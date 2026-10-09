/**
 * `derived:check` on a translation written into a TEMPORARY `derived/cms137/` (never `measures/derived/`):
 * the fixture translation from the committed cms137 bundle, a synthetic sidecar, a synthetic Cypress deck
 * and value-set CSV, a stubbed deck calculation and a stubbed MADiE runner. It must refuse bytes that are
 * not the pinned ones, write nothing on any failure, record both oracles against the hashes it computed
 * when everything passes, and run the MADiE comparison with no deck and no sidecar at all.
 *
 * The changed-library tests (#779) edit CMS137's Hospice library — included by the main library alone, as
 * AdvancedIllnessandFrailty is in CMS130 — by wrapping one define in a `Not`, and rename it through the
 * same `rewriteChangedLibrary` the builder uses. No CMS CQL is read or written: only committed ELM.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { AgreementCalculate, AgreementSubjectResult } from "../../standards/cypress-agreement.ts";
import { readCypressDeck } from "../../standards/cypress-agreement.ts";
import { translationIdentity } from "../../standards/derived-build.ts";
import { changedLibraryIdentity, rewriteChangedLibrary } from "../../standards/derived-changed-library.ts";
import { declaredPopulations } from "../../standards/edit-cases.ts";
import {
  classifyPopulationAgreement,
  type FhirBundle,
  type LoadedOfficialMeasure,
  type OfficialCaseResult,
  type OfficialMeasureRun,
  type PopulationCounts,
  type RunOfficialMeasureOptions,
} from "../../standards/official-cases.ts";
import { derivedCms137, FIXTURE_URL } from "../../test-support/derived-fixture.ts";
import { loadOfficialArtifact, readArtifactDir, type DerivedChangedLibrary, type OfficialArtifact, type OfficialManifest } from "../../wiring/official-artifacts.ts";
import { requiredOids } from "../../wiring/official-executor-adapter.ts";
import { verifyTerminology, type LoadedTerminology } from "../../wiring/official-terminology.ts";
import {
  DerivedCheckUsageError,
  declaredPackageOids,
  measureSpecOids,
  differingDefines,
  main,
  mainLibraryName,
  matchExpectedDifferences,
  parseArgs,
  parseExpectedDifferences,
  translatedUpstreamBundle,
  withChangedLibraryBroken,
  type DerivedCheckDeps,
} from "./derived-check.ts";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const base = derivedCms137();
const official = loadOfficialArtifact("cms137")!;
// The OIDs the committed ELM declares, read at run time — no value-set content is written into the test.
const REQUIRED = [...new Set(requiredOids(base))];
const SNOMED = "http://snomed.info/sct";
const SNOMED_OID = "2.16.840.1.113883.6.96";
const RELEASE = "eCQM Update 2026-05-14";
type Codes = Map<string, Array<{ system: string; code: string }>>;
const OFFICIAL_CODES: Codes = new Map(REQUIRED.map((oid, i) => [oid, [{ system: SNOMED, code: `T${i}A` }, { system: SNOMED, code: `T${i}B` }]]));
/** The release adds a code to the first declared set and drops one from the second. */
const RELEASE_CODES: Codes = new Map(
  REQUIRED.map((oid, i) => {
    const codes = OFFICIAL_CODES.get(oid)!;
    return [oid, i === 0 ? [...codes, { system: SNOMED, code: "T0NEW" }] : i === 1 ? [codes[0]!] : codes];
  }),
);
const PACKAGE_BYTES = "synthetic CMS package";
/** Relative to the fixture root, which is the check's cwd. */
const PACKAGE_CQL = "package-cql";
const PATIENTS = [
  { id: "p1", given: "Alpha", family: "Synthetic" },
  { id: "p2", given: "Beta", family: "Synthetic" },
];

interface Fixture {
  root: string;
  dir: string;
  deck: string;
  pkg: string;
  manifestPath: string;
  bundleSha: string;
  terminologySha: string;
  csvBytes: Buffer;
}

/** A Cypress-shaped deck: p1 in both numerators and stratum 1, p2 in both denominators and stratum 2. */
function writeDeck(root: string, title = "Test bundle (eCQM value sets as of May 14, 2026)"): string {
  const deck = join(root, "deck");
  mkdirSync(join(deck, "calculations", "individual-results"), { recursive: true });
  mkdirSync(join(deck, "patients"));
  mkdirSync(join(deck, "value-sets"));
  writeFileSync(join(deck, "bundle.json"), JSON.stringify({ version: "2026.1.0", title, measure_period_start: 1735689600, effective_date: 1767225599 }));
  writeFileSync(join(deck, "calculations", "measure-id-mapping.csv"), "m137,CMS137v15\n");
  writeFileSync(join(deck, "calculations", "patient-id-mapping.csv"), PATIENTS.map((p) => `${p.id},${p.given},${p.family}`).join("\n"));
  const rows: Array<[string, string, number]> = [
    ["p1", "PopulationSet_1", 1],
    ["p1", "PopulationSet_2", 1],
    ["p1", "PopulationSet_1_Stratification_1", 1],
    ["p1", "PopulationSet_2_Stratification_1", 1],
    ["p2", "PopulationSet_1", 0],
    ["p2", "PopulationSet_2", 0],
    ["p2", "PopulationSet_1_Stratification_2", 0],
    ["p2", "PopulationSet_2_Stratification_2", 0],
  ];
  rows.forEach(([patient, key, numer], i) =>
    writeFileSync(
      join(deck, "calculations", "individual-results", `individual-result-${i}.json`),
      JSON.stringify({ measure_id: "m137", patient_id: patient, population_set_key: key, IPP: 1, DENOM: 1, DENEX: 0, NUMER: numer }),
    ),
  );
  for (const p of PATIENTS) writeFileSync(join(deck, "patients", `${p.given}_${p.family}.xml`), `<placeholder ${p.id}/>`);
  const header = "OID|ValueSetName|ExpansionVersion|Code|Descriptor|CodeSystemName|CodeSystemVersion|CodeSystemOID|Purpose";
  const lines = [...RELEASE_CODES].flatMap(([oid, codes]) =>
    codes.map((c, i) => `${oid}|Set|${i % 2 ? `Release:${RELEASE}` : RELEASE}|${c.code}|d|SNOMEDCT|v|${SNOMED_OID}|""`),
  );
  writeFileSync(join(deck, "value-sets", "value-set-codes.csv"), [header, ...lines].join("\n") + "\n");
  return deck;
}

// ---- a changed library: CMS137's Hospice, edited and renamed as the builder renames one -------------

const HOSPICE = base.bundle.entry.map((e) => e.resource as Record<string, unknown>).find((r) => r["resourceType"] === "Library" && r["name"] === "Hospice")!;
const HOSPICE_VERSION = String(HOSPICE["version"]);
/** A define NAME (never CQL): the one the edit below changes. */
const HOSPICE_DEFINE = "Has Hospice Services";
const CHANGED = changedLibraryIdentity("Hospice", HOSPICE_VERSION, translationIdentity("cms137", 2027, "CMS137v15"));
const CHANGED_ENTRY: DerivedChangedLibrary = {
  name: CHANGED.name,
  version: CHANGED.version,
  from: { name: "Hospice", version: HOSPICE_VERSION, elmSha256: `sha256:${"9".repeat(64)}` },
  translationSha256: `sha256:${"8".repeat(64)}`,
};

type ElmJson = { library: { identifier: { id: string; version: string }; statements: { def: Array<Record<string, unknown>> } } };
const elmOf = (library: Record<string, unknown>): ElmJson =>
  JSON.parse(Buffer.from((library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!.data, "base64").toString("utf8")) as ElmJson;

/**
 * The cms137 fixture with Hospice made a changed library: `edited` wraps "Has Hospice Services" in a
 * `Not` (a stand-in for CMS130's one-phrase edit); unedited carries CMS's logic under WorkWell's name.
 */
function changedTranslation(edited: boolean): OfficialArtifact {
  const elm = elmOf(HOSPICE);
  if (edited) {
    const def = elm.library.statements.def.find((d) => d["name"] === HOSPICE_DEFINE)!;
    def["expression"] = { type: "Not", operand: def["expression"] };
  }
  const bundle = rewriteChangedLibrary(base.bundle as unknown as { entry?: Array<{ resource?: Record<string, unknown> }> }, { name: "Hospice", version: HOSPICE_VERSION }, elm as never, CHANGED);
  const block = base.manifest.derived!;
  return {
    ...base,
    bundle: bundle as unknown as OfficialArtifact["bundle"],
    manifest: {
      ...base.manifest,
      derived: { ...block, unchangedLibraries: block.unchangedLibraries.filter((l) => l.name !== "Hospice"), changedLibraries: [CHANGED_ENTRY] },
    },
  };
}

/** The deck's period, which `loadedCases` reports. */
const MADIE_PERIOD = { start: "2026-01-01", end: "2026-12-31" };
const full = (denex: 0 | 1): PopulationCounts => ({ "initial-population": 1, denominator: 1, "denominator-exclusion": denex, numerator: 0, "denominator-exception": 0 });
/** As the file states a rate: the populations cms137 declares, and nothing else. */
const stated = (denex: 0 | 1) => ({ "initial-population": 1, denominator: 1, "denominator-exclusion": denex, numerator: 0 });
/** Two rates each (cms137 has two groups). e1 is excluded by the edit alone; e2 by both logics. */
const EDIT_CASES = {
  measurementPeriod: MADIE_PERIOD,
  cases: [
    { id: "e1", description: "excluded by the edit alone", resources: [{ resourceType: "Patient", id: "ep1" }], expected: { cms: [stated(0), stated(0)], translation: [stated(1), stated(1)] } },
    { id: "e2", description: "excluded by both logics", resources: [{ resourceType: "Patient", id: "ep2" }, { resourceType: "Condition", id: "c" }], expected: { cms: [stated(1), stated(1)], translation: [stated(1), stated(1)] } },
  ],
};
/** What the stubbed engine actually answers for each edit case on each logic. */
type EditTruth = Record<string, Record<"cms" | "translation", PopulationCounts[]>>;
const EDIT_TRUTH: EditTruth = {
  e1: { cms: [full(0), full(0)], translation: [full(1), full(1)] },
  e2: { cms: [full(1), full(1)], translation: [full(1), full(1)] },
};
/** The two differences the edited Hospice define makes on the stubbed deck: case c1, both groups. */
const OBSERVED_DIFFERENCES = [0, 1].map((g) => ({ case: "c1", key: `g${g}|Hospice.${HOSPICE_DEFINE}`, cms: 'false|"NA"|NA', ours: 'true|"NA"|NA' }));
const LISTED = OBSERVED_DIFFERENCES.map((d) => ({ ...d, reason: "the edit excludes c1's hospice encounter; no population moves" }));

function fixture(
  options: {
    translationCodes?: Codes;
    stalePins?: boolean;
    sidecar?: boolean;
    packageSha?: string;
    deckTitle?: string;
    /** `edited`/`unedited`: Hospice is a changed library (see `changedTranslation`). */
    changed?: "edited" | "unedited";
    /** null: no edits.json at all. Default `[]`, or one edit when `changed` is set. */
    edits?: unknown;
    /** null: no edit-cases.json. Default EDIT_CASES when `changed` is set, else none. */
    editCases?: unknown;
    /** null: no madie-expected-differences.json. Default LISTED when `changed` is `edited`, else none. */
    expectedDifferences?: unknown;
  } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "derived-check-"));
  const dir = join(root, "derived", "cms137");
  mkdirSync(dir, { recursive: true });
  const translation = options.changed ? changedTranslation(options.changed === "edited") : base;
  const bundleText = JSON.stringify(translation.bundle);
  writeFileSync(join(dir, "bundle.json"), bundleText);
  const edits = options.edits === undefined ? (options.changed ? [{ library: "Hospice", note: "one edit; the check reads only how many" }] : []) : options.edits;
  if (edits !== null) writeFileSync(join(dir, "edits.json"), `${JSON.stringify(edits)}\n`);
  const editCases = options.editCases === undefined ? (options.changed ? EDIT_CASES : null) : options.editCases;
  if (editCases !== null) writeFileSync(join(dir, "edit-cases.json"), JSON.stringify(editCases));
  const expectedDifferences = options.expectedDifferences === undefined ? (options.changed === "edited" ? LISTED : null) : options.expectedDifferences;
  if (expectedDifferences !== null) writeFileSync(join(dir, "madie-expected-differences.json"), JSON.stringify(expectedDifferences));
  const codes = options.translationCodes ?? RELEASE_CODES;
  const terminologyText = JSON.stringify({
    catalogId: "cms137",
    source: { repo: "synthetic", ref: "0", measure: "cms137" },
    valueSets: REQUIRED.map((oid) => ({ oid, url: `http://cts.nlm.nih.gov/fhir/ValueSet/${oid}`, declaredTotal: codes.get(oid)!.length, codes: codes.get(oid) })),
  });
  if (options.sidecar !== false) writeFileSync(join(dir, "terminology.json"), terminologyText);
  const bundleSha = sha(bundleText);
  const terminologySha = sha(terminologyText);
  const pkg = join(root, "package.zip");
  writeFileSync(pkg, PACKAGE_BYTES);
  const manifest: OfficialManifest = {
    ...translation.manifest,
    sha256: options.stalePins ? base.manifest.sha256 : bundleSha,
    terminology: { ...base.manifest.terminology!, sha256: options.stalePins ? base.manifest.terminology!.sha256 : terminologySha },
    derived: {
      ...translation.manifest.derived!,
      derivedFrom: { ecqm: "CMS137v15", packageSha256: options.packageSha ?? sha(PACKAGE_BYTES) },
      oracles: [
        { ...base.manifest.derived!.oracles[0]!, name: "earlier-check" },
        { ...base.manifest.derived!.oracles[0]!, result: "fail", agree: 0 },
      ],
    },
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // The package's CQL as `--package-cql-dir` reads it: synthetic declarations of exactly the translation's sets.
  mkdirSync(join(root, PACKAGE_CQL));
  writeFileSync(join(root, PACKAGE_CQL, "Main.cql"), REQUIRED.map((oid, i) => `valueset "Set ${i}": 'urn:oid:${oid}'`).join("\n") + "\n");
  const deck = writeDeck(root, options.deckTitle);
  return { root, dir, deck, pkg, manifestPath, bundleSha, terminologySha, csvBytes: readFileSync(join(deck, "value-sets", "value-set-codes.csv")) };
}

const importDeps = {
  importDocument: () => ({ bundle: { resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", id: "x" } }] }, untranslatedTemplates: [] }),
  prepare: (bundle: unknown) => bundle,
};

/** Whether a bundle's main library has had "Initial Population" replaced by a literal (the break). */
function ippBroken(bundle: { entry: Array<{ resource: Record<string, unknown> }> }): boolean {
  const name = mainLibraryName(bundle);
  const library = bundle.entry.map((e) => e.resource).find((r) => r["resourceType"] === "Library" && r["name"] === name)!;
  const data = (library["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!.data;
  const elm = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { library: { statements: { def: Array<{ name: string; expression: { type: string } }> } } };
  return elm.library.statements.def.find((d) => d.name === "Initial Population")!.expression.type === "Literal";
}

const pops = (ipp: boolean, numer: boolean) => [
  { populationType: "initial-population", result: ipp },
  { populationType: "denominator", result: ipp },
  { populationType: "denominator-exclusion", result: false },
  { populationType: "numerator", result: numer },
];
const strata = (inStratum: number) => [0, 1, 2].map((m) => ({ result: m === inStratum }));
const ANSWERS: Record<string, AgreementSubjectResult> = {
  p1: { rates: [pops(true, true), pops(true, true)], strata: [strata(0), strata(0)] },
  p2: { rates: [pops(true, false), pops(true, false)], strata: [strata(1), strata(1)] },
};

interface DeckCall {
  measureUrl: unknown;
  broken: boolean;
  codes: string[];
}

/** A deck calculation: the right answers, or nobody in anything when the main library is broken. */
function deckStub(calls: DeckCall[], answers = ANSWERS, honourBreak = true): AgreementCalculate {
  return async (input) => {
    const measure = input.bundle.entry.find((e) => e.resource["resourceType"] === "Measure")!.resource;
    const broken = ippBroken(input.bundle);
    const codes = (input.valueSetCache as Array<{ expansion?: { contains?: Array<{ code: string }> } }>).flatMap((vs) => (vs.expansion?.contains ?? []).map((c) => c.code));
    calls.push({ measureUrl: measure["url"], broken, codes });
    const ids = input.patientBundles.map((b) => String((b as { entry: Array<{ resource: { id: string } }> }).entry[0]!.resource.id));
    const nobody: AgreementSubjectResult = { rates: [pops(false, false), pops(false, false)], strata: [strata(-1), strata(-1)] };
    return { bySubject: new Map(ids.map((id) => [id, broken && honourBreak ? nobody : answers[id]!])) };
  };
}

// ---- MADiE stubs ----------------------------------------------------------------------------------

type ElmLibrary = { library: { annotation?: unknown[]; statements: { def: Array<Record<string, unknown>> } } };

/** Rewrite one library's ELM in place. */
function editElm(resource: Record<string, unknown>, edit: (elm: ElmLibrary) => void): void {
  const content = (resource["content"] as Array<{ contentType: string; data: string }>).find((c) => c.contentType === "application/elm+json")!;
  const elm = JSON.parse(Buffer.from(content.data, "base64").toString("utf8")) as ElmLibrary;
  edit(elm);
  content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
}

/**
 * CMS's upstream bundle as MADiE ships it: the committed libraries, but each ELM carrying what the
 * vendored copies were stripped of — a translator annotation and a `localId` on every expression — plus a
 * ValueSet. So "equal once stripped" is exercised on every run, not assumed.
 */
function upstreamWith(edit: (libraries: Map<string, Record<string, unknown>>, bundle: FhirBundle) => void = () => {}): FhirBundle {
  const bundle = JSON.parse(JSON.stringify(official.bundle)) as FhirBundle;
  let next = 0;
  const stamp = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(stamp);
    else if (node && typeof node === "object") {
      if (typeof (node as Record<string, unknown>)["type"] === "string") (node as Record<string, unknown>)["localId"] = String(++next);
      Object.values(node).forEach(stamp);
    }
  };
  const libraries = new Map<string, Record<string, unknown>>();
  for (const { resource } of bundle.entry) {
    if (resource.resourceType !== "Library") continue;
    libraries.set(String(resource["name"]), resource);
    editElm(resource, (elm) => {
      stamp(elm.library.statements);
      elm.library.annotation = [{ type: "CqlToElmInfo", translatorVersion: "3.x" }];
    });
  }
  bundle.entry.push({ resource: { resourceType: "ValueSet", id: "kept", url: "http://cts.nlm.nih.gov/fhir/ValueSet/9.9.9" } });
  edit(libraries, bundle);
  return bundle;
}
const upstreamBundle = upstreamWith();

const counts = (ipp: number, numer: number): PopulationCounts => ({
  "initial-population": ipp,
  denominator: ipp,
  "denominator-exclusion": 0,
  numerator: numer,
  "denominator-exception": 0,
});

function loadedCases(_contentDir?: string, _measure?: string, measureBundle: FhirBundle = upstreamBundle): LoadedOfficialMeasure {
  return {
    measure: "cms137",
    measureName: "CMS137FHIRSUDTxInitEngagement",
    contentDir: "unused",
    measureBundle,
    cases: ["c1", "c2"].map((uuid, i) => ({ uuid, name: uuid, title: uuid, series: "s", description: "d", patientId: `p${i + 1}`, expected: counts(1, i === 0 ? 1 : 0) })),
    measurementPeriod: { start: "2026-01-01", end: "2026-12-31" },
    valueSets: { total: 0, expanded: 0, truncated: [] },
    valueSetResources: [],
  };
}

interface MadieCall {
  measureUrl: unknown;
  keptValueSet: boolean;
  broken: boolean;
  /** Each Library the runner received, by name, as its resource's exact JSON. */
  libraries: Map<string, string>;
  /** The case uuids it was asked to run. */
  cases: string[];
  /** Whether the changed library's edited define arrived forced null. */
  changedBroken: boolean;
}

/** The expression type of one define in a bundle library's ELM. */
const defExpressionType = (library: Record<string, unknown>, define: string): unknown =>
  (elmOf(library).library.statements.def.find((d) => d["name"] === define)?.["expression"] as { type?: unknown } | undefined)?.type;

interface MadieStubOptions {
  sexOnTranslation?: string;
  honourBreak?: boolean;
  strataOnTranslation?: boolean;
  calculationErrorOnTranslation?: string;
  /**
   * Report the Hospice define too: CMS's copy `false` on every case; WorkWell's changed copy `true` on
   * c1 alone (the edit's one difference per group), and null on every case when the define arrives forced
   * null — unless `honourChangedBreak` is false (an engine that ignores the bundle's changed library).
   */
  changed?: boolean;
  honourChangedBreak?: boolean;
  /** Edit cases: what each logic answers. A case named by `skipEditCase` comes back unscored, as the
   *  harness returns a case missing `expected`; one named by `dropEditCase` does not come back at all. */
  editTruth?: EditTruth;
  skipEditCase?: string;
  dropEditCase?: string;
  /** Edit cases on the translation answer CMS's logic's way: an edit that did not take. */
  editLostOnTranslation?: boolean;
}

/**
 * fqm's per-case output for either bundle, with the main library named as the bundle names it — so the
 * translation's defines arrive under its renamed library, exactly as fqm reports them.
 */
function madieStub(calls: MadieCall[], options: MadieStubOptions = {}) {
  return async (loaded: LoadedOfficialMeasure, runOptions: RunOfficialMeasureOptions = {}): Promise<OfficialMeasureRun> => {
    const bundle = loaded.measureBundle as unknown as { entry: Array<{ resource: Record<string, unknown> }> };
    const measure = bundle.entry.find((e) => e.resource["resourceType"] === "Measure")!.resource;
    const translation = String(measure["url"]).startsWith("urn:workwell:");
    const broken = ippBroken(bundle) && options.honourBreak !== false;
    const libraries = bundle.entry.filter((e) => e.resource["resourceType"] === "Library").map((e) => e.resource);
    const changedLibrary = libraries.find((r) => r["name"] === CHANGED.name);
    const changedBroken = !!changedLibrary && defExpressionType(changedLibrary, HOSPICE_DEFINE) === "Null";
    calls.push({
      measureUrl: measure["url"],
      keptValueSet: bundle.entry.some((e) => e.resource["id"] === "kept"),
      broken,
      libraries: new Map(libraries.map((r) => [String(r["name"]), JSON.stringify(r)])),
      cases: loaded.cases.map((c) => c.uuid),
      changedBroken,
    });
    const shell = {
      measure: "cms137" as const,
      measureName: loaded.measureName,
      measurementPeriod: loaded.measurementPeriod,
      valueSets: loaded.valueSets,
      valueSetMode: "measure-bundle" as const,
      supplementedOids: [],
      trustMetaProfile: false,
      profileRetry: false,
      retrieveSignal: true,
      engineWarnings: 0,
    };

    if (loaded.cases.length > 0 && loaded.cases.every((c) => c.series === "WorkWell edit case")) {
      const side = translation && !options.editLostOnTranslation ? "translation" : "cms";
      const truth = options.editTruth ?? EDIT_TRUTH;
      const cases: OfficialCaseResult[] = loaded.cases
        .filter((c) => c.uuid !== options.dropEditCase)
        .map((c) => {
          if (c.uuid === options.skipEditCase) return { ...c };
          const actualRates = truth[c.uuid]![side];
          const agreement = classifyPopulationAgreement("cms137", c.uuid, c.expected!, actualRates[0]!, { expected: c.expectedRates!, actual: actualRates });
          return { ...c, actual: actualRates[0], actualRates, agreement };
        });
      const agreeing = cases.filter((c) => c.agreement?.status === "expected-agreement").length;
      return { ...shell, cases, summary: { total: cases.length, expectedAgreements: agreeing, referenceAgreements: 0, unexpectedMismatches: cases.length - agreeing, errors: 0 } };
    }

    const main = mainLibraryName(bundle);
    const hospice = (i: number) =>
      changedLibrary
        ? { libraryName: CHANGED.name, statementName: HOSPICE_DEFINE, raw: changedBroken && options.honourChangedBreak !== false ? null : i === 0, final: "NA", relevance: "NA" }
        : { libraryName: "Hospice", statementName: HOSPICE_DEFINE, raw: false, final: "NA", relevance: "NA" };
    const output = {
      results: loaded.cases.map((c, i) => ({
        patientId: c.patientId,
        detailedResults: [0, 1].map(() => ({
          populationResults: [],
          statementResults: [
            { libraryName: main, statementName: "Numerator", raw: !broken && i === 0, final: "TRUE", relevance: "TRUE" },
            { libraryName: "SupplementalDataElements", statementName: "SDE Sex", raw: translation && options.sexOnTranslation ? options.sexOnTranslation : "F", final: "NA", relevance: "NA" },
            ...(options.changed ? [hospice(i)] : []),
          ],
          stratifierResults: [{ strataId: "Stratification_1_1", result: !(translation && options.strataOnTranslation === false) }],
        })),
      })),
    };
    runOptions.onOutput?.(output as never);
    const calculationError = translation ? options.calculationErrorOnTranslation : undefined;
    const cases = loaded.cases.map((c, i) => {
      const rate = counts(broken ? 0 : 1, !broken && i === 0 ? 1 : 0);
      const status = broken ? ("mismatch" as const) : ("expected-agreement" as const);
      return { ...c, actual: rate, actualRates: [rate, rate], agreement: { pass: !broken, status, differences: [] } };
    });
    return {
      ...shell,
      ...(calculationError ? { calculationError } : {}),
      cases,
      summary: { total: cases.length, expectedAgreements: broken ? 0 : cases.length, referenceAgreements: 0, unexpectedMismatches: broken ? cases.length : 0, errors: 0 },
    };
  };
}

function setup(f: Fixture, over: Partial<DerivedCheckDeps> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const deckCalls: DeckCall[] = [];
  const madieCalls: MadieCall[] = [];
  const derivedRoot = join(f.root, "derived");
  const loadTerminology = (artifact: OfficialArtifact): LoadedTerminology => {
    if (artifact.kind !== "derived") return { ok: true, codesByOid: OFFICIAL_CODES };
    const pin = artifact.manifest.terminology!;
    let raw: string;
    try {
      raw = readFileSync(join(derivedRoot, artifact.manifest.catalogId, pin.file), "utf8");
    } catch {
      return { ok: false, problem: "the sidecar is absent" };
    }
    return verifyTerminology(artifact.manifest.catalogId, pin.sha256, raw);
  };
  const deps: Partial<DerivedCheckDeps> = {
    cwd: f.root,
    derivedRoot,
    loadDerived: (id) => readArtifactDir("derived", id, pathToFileURL(`${derivedRoot}/`)).artifact,
    loadOfficial: () => official,
    loadTerminology,
    semantics: () => ({ trustMetaProfile: false }),
    importDeps,
    calculate: deckStub(deckCalls),
    verifyUpstream: () => {},
    loadCases: loadedCases,
    runCases: madieStub(madieCalls),
    pinnedStatements: { cms137: 8 },
    requiredCases: { cms137: 2 },
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    ...over,
  };
  return { deps, logs, errors, deckCalls, madieCalls };
}

const deckArgs = (f: Fixture, ...extra: string[]) => ["--catalog-id", "cms137", "--cypress-bundle", f.deck, "--package", f.pkg, ...extra];
/** A recording run: every check, the package's value-set declarations included. */
const recordArgs = (f: Fixture) => deckArgs(f, "--package-cql-dir", PACKAGE_CQL, "--record");

// ---- arguments ----------------------------------------------------------------------------------------

test("arguments: the deck and package are required unless --madie runs alone, and --record always needs them", async () => {
  assert.throws(() => parseArgs(["--catalog-id", "cms137", "--madie", "--record"]), (e: unknown) => e instanceof DerivedCheckUsageError && /--cypress-bundle is required with --record/.test(e.message));
  assert.throws(() => parseArgs(["--catalog-id", "cms137", "--cypress-bundle", "d"]), /--package is required unless --madie runs alone/);
  assert.throws(() => parseArgs(["--catalog-id", "cms137", "--madie", "--csv", "x.csv"]), /--csv needs --cypress-bundle/);
  assert.throws(() => parseArgs(["--catalog-id", "cms137", "--madie", "--package-cql-dir", "d"]), /--package-cql-dir needs --package/);
  assert.throws(() => parseArgs(["--catalog-id", "CMS137", "--madie"]), DerivedCheckUsageError);
  assert.throws(() => parseArgs(["--catalog-id", "cms137", "--madie", "--surprise"]), /unknown argument/);
  assert.throws(() => parseArgs(["--catalog-id", "cms137", "--madie", "--limit", "many"]), /--limit takes a whole number/);
  assert.throws(() => parseArgs(["--catalog-id", "cms137", "--catalog-id", "cms2", "--madie"]), /--catalog-id given twice/);
  assert.throws(() => parseArgs(["--catalog-id", "--madie"]), /--catalog-id needs a value/);
  assert.deepEqual(parseArgs(["--catalog-id", "cms137", "--madie"]), { catalogId: "cms137", record: false, madie: true, contentDir: ".official-content", limit: 20 });

  const f = fixture();
  const { deps, errors } = setup(f);
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(["--catalog-id", "cms137", "--madie", "--record"], deps), 2, "--record without the deck is a usage error");
  assert.match(errors.join("\n"), /--cypress-bundle is required with --record/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);

  // A record vouches for every check, so --record without the package's declarations is a usage error,
  // stopped before anything runs; without --record the same run only reports (and says so, below).
  const noDeclarations = deckArgs(f, "--record");
  assert.throws(() => parseArgs(noDeclarations), (e: unknown) => e instanceof DerivedCheckUsageError && /--package-cql-dir is required with --record/.test(e.message));
  assert.equal(parseArgs(deckArgs(f)).packageCqlDir, undefined, "optional without --record");
  const usage = setup(f);
  assert.equal(await main(noDeclarations, usage.deps), 2);
  assert.match(usage.errors.join("\n"), /--package-cql-dir is required with --record/);
  assert.equal(usage.deckCalls.length, 0, "nothing ran");
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

// ---- the full check -------------------------------------------------------------------------------------

test("--record on a pass writes both records against the hashes it computed, keeping everything else", async () => {
  const f = fixture();
  const { deps, logs, errors, deckCalls } = setup(f);
  const before = readFileSync(f.manifestPath, "utf8");
  const code = await main(recordArgs(f), deps);
  assert.equal(code, 0, errors.join("\n"));

  // The deck ran the translation, on its own terminology, and then the break.
  assert.deepEqual(deckCalls.map((c) => [c.measureUrl, c.broken]), [[FIXTURE_URL, false], [FIXTURE_URL, true]]);
  assert.ok(deckCalls[0]!.codes.includes("T0NEW"), "the translation's own expansion, not CMS's");

  const text = readFileSync(f.manifestPath, "utf8");
  assert.ok(text.endsWith("}\n") && text.includes('\n  "catalogId": "cms137"'), "2-space indent and a trailing newline");
  const was = JSON.parse(before) as OfficialManifest;
  const now = JSON.parse(text) as OfficialManifest;
  assert.deepEqual(Object.keys(now), Object.keys(was), "top-level key order kept");
  assert.deepEqual(Object.keys(now.derived!), Object.keys(was.derived!), "derived key order kept");
  assert.deepEqual({ ...now, derived: { ...now.derived!, oracles: [] } }, { ...was, derived: { ...was.derived!, oracles: [] } }, "only the oracles changed");
  const [earlier, deck, terminology] = now.derived!.oracles;
  assert.deepEqual(earlier, was.derived!.oracles[0], "an oracle of another name is kept");
  const ranAgainst = { artifactSha256: f.bundleSha, terminologySha256: f.terminologySha };
  assert.deepEqual(deck, {
    name: "cypress-deck",
    inputSha256: readCypressDeck(f.deck, "cms137").inputSha256,
    period: { start: "2025-01-01", end: "2025-12-31" },
    agree: 2,
    total: 2,
    result: "pass",
    ranAgainst,
  });
  assert.deepEqual(terminology, {
    name: "terminology-equivalence",
    inputSha256: sha(f.csvBytes),
    period: { start: "2027-01-01", end: "2027-12-31" },
    agree: REQUIRED.length,
    total: REQUIRED.length,
    result: "pass",
    ranAgainst,
  });
  assert.equal(now.derived!.oracles.length, 3, "the stale cypress-deck record was replaced, not duplicated");
  assert.match(logs.join("\n"), /2 changed by the release · 2 changed by the translation/);
  assert.doesNotMatch(logs.join("\n"), /Alpha|Beta|T0NEW|T0A/, "no patient name and no code is printed");
  assert.match(
    logs.join("\n"),
    new RegExp(
      `package declarations: ${REQUIRED.length} value set\\(s\\) in 1 \\.cql file\\(s\\); its measure specification lists nothing ` +
        `\\(no HQMF in the directory, so no declaration is excused\\); the translation declares ${REQUIRED.length}`,
    ),
  );
  assert.doesNotMatch(logs.join("\n"), /no --package-cql-dir/);
  rmSync(f.root, { recursive: true, force: true });
});

test("without --record a pass writes nothing, and says loudly when the declarations went unchecked", async () => {
  const f = fixture();
  const before = readFileSync(f.manifestPath, "utf8");
  const { deps, logs } = setup(f);
  assert.equal(await main(deckArgs(f), deps), 0);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
  assert.match(logs.join("\n"), /NOTICE \*+ no --package-cql-dir: the package's value-set DECLARATIONS were NOT checked/);
});

test("bytes on disk that are not the pinned ones are refused", async () => {
  const f = fixture({ stalePins: true });
  const { deps, errors, deckCalls } = setup(f);
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(recordArgs(f), deps), 1);
  assert.match(errors.join("\n"), /bundle\.json on disk hashes to sha256:[0-9a-f]{64}, the manifest pins sha256:e{64}/);
  assert.equal(deckCalls.length, 0, "nothing ran");
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);

  // A sidecar whose bytes moved after the pin was taken: the bundle matches, the terminology does not.
  const g = fixture();
  writeFileSync(join(g.dir, "terminology.json"), "{}");
  const second = setup(g);
  assert.equal(await main(recordArgs(g), second.deps), 1);
  assert.match(second.errors.join("\n"), /terminology\.json on disk hashes to/);
});

test("a failing deck oracle exits 1 and leaves manifest.json untouched", async () => {
  const f = fixture();
  const flipped = { ...ANSWERS, p2: { ...ANSWERS["p2"]!, rates: [pops(true, true), pops(true, false)] } };
  const calls: DeckCall[] = [];
  const { deps, errors } = setup(f, { calculate: deckStub(calls, flipped) });
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(recordArgs(f), deps), 1);
  assert.match(errors.join("\n"), /cypress-deck: 1\/2 patients agree on every row/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

test("an oracle that cannot see the break fails, however well it agrees", async () => {
  const f = fixture();
  const { deps, errors } = setup(f, { calculate: deckStub([], ANSWERS, false) });
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(recordArgs(f), deps), 1);
  assert.match(errors.join("\n"), /breaking the translation did not lower agreement/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

test("a translation whose codes differ from the release fails terminology-equivalence and records nothing", async () => {
  // The first set re-expanded without the code the release added.
  const f = fixture({ translationCodes: new Map([...RELEASE_CODES].map(([oid, codes]) => [oid, codes.filter((c) => c.code !== "T0NEW")])) });
  const { deps, errors, logs } = setup(f);
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(recordArgs(f), deps), 1);
  // Matched as a string, not a regex built from data: an OID is data, and escaping it by hand is the
  // CodeQL "incomplete escaping" shape this repo already retired once (4b727c27).
  assert.ok(
    errors.join("\n").includes(`terminology-equivalence: 1 declared value set(s) differ from the CSV: ${REQUIRED[0]}`),
    `expected the differing set to be named; got:\n${errors.join("\n")}`,
  );
  assert.match(logs.join("\n"), /missing 1, extra 0\) — DIFFERS/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

test("a package that is not the one translated from is refused", async () => {
  const f = fixture({ packageSha: `sha256:${"0".repeat(64)}` });
  const { deps, errors, deckCalls } = setup(f);
  assert.equal(await main(recordArgs(f), deps), 1);
  assert.match(errors.join("\n"), /--package hashes to sha256:[0-9a-f]{64}, but the translation was derived from sha256:0{64}/);
  assert.equal(deckCalls.length, 0);
});

test("every value set the package's CQL declares must be one the translation declares", async () => {
  const f = fixture();
  const cql = join(f.root, "cql", "nested");
  mkdirSync(cql, { recursive: true });
  const declare = (oids: readonly string[]) => oids.map((oid, i) => `valueset "Set ${i}": 'urn:oid:${oid}'`).join("\n");
  writeFileSync(join(cql, "Main.cql"), `library Main version '15.0.000'\n${declare(REQUIRED.slice(0, 3))}\n`);
  writeFileSync(join(f.root, "cql", "Other.cql"), `  valueset "Fhir form": 'http://cts.nlm.nih.gov/fhir/ValueSet/${REQUIRED[3]}'\n`);
  assert.deepEqual(declaredPackageOids(join(f.root, "cql")), { oids: new Set(REQUIRED.slice(0, 4)), files: 2 });
  const ok = setup(f);
  assert.equal(await main(deckArgs(f, "--package-cql-dir", "cql"), ok.deps), 0, ok.errors.join("\n"));
  assert.match(ok.logs.join("\n"), new RegExp(`info: the translation declares ${REQUIRED.length - 4} value set\\(s\\) the package's CQL does not`));

  writeFileSync(join(cql, "Extra.cql"), `valueset "Not ours": 'urn:oid:1.2.3.4.5.6'\n`);
  const extra = setup(f);
  assert.equal(await main(deckArgs(f, "--package-cql-dir", "cql"), extra.deps), 1);
  assert.match(extra.errors.join("\n"), /the package declares 1 value set\(s\) the translation does not: 1\.2\.3\.4\.5\.6/);

  mkdirSync(join(f.root, "empty"));
  const empty = setup(f);
  assert.equal(await main(deckArgs(f, "--package-cql-dir", "empty"), empty.deps), 1);
  assert.match(empty.errors.join("\n"), /holds no \.cql files/);
});

test("a shared library's declaration the measure specification does not list is excused, and nothing else is (#779)", async () => {
  const f = fixture();
  const dir = join(f.root, "pkg");
  mkdirSync(join(dir, "cql"), { recursive: true });
  const declare = (oids: readonly string[]) => oids.map((oid, i) => `valueset "Set ${i}": 'urn:oid:${oid}'`).join("\n");
  const hqmf = (oids: readonly string[]) =>
    `<?xml version="1.0"?>\n<QualityMeasureDocument xmlns="urn:hl7-org:v3">\n${oids.map((oid) => `  <value valueSet="${oid}"/>`).join("\n")}\n</QualityMeasureDocument>\n`;
  // The measure's own CQL declares the translation's sets; a shared library also declares one the
  // measure never uses (CQMCommonQDM's hospitalization sets, for CMS130).
  writeFileSync(join(dir, "cql", "Main.cql"), `library Main version '15.0.000'\n${declare(REQUIRED)}\n`);
  writeFileSync(join(dir, "cql", "Common.cql"), `library Common version '9.0.000'\n${declare(["1.2.3.4.5.6"])}\n`);
  // An XML file that is not a measure specification is not read as one.
  writeFileSync(join(dir, "other.xml"), `<?xml version="1.0"?>\n<Bundle><value valueSet="9.9.9.9"/></Bundle>\n`);

  // No specification: nothing is excused, exactly as before.
  const strict = setup(f);
  assert.equal(await main(deckArgs(f, "--package-cql-dir", "pkg"), strict.deps), 1);
  assert.match(strict.errors.join("\n"), /the package declares 1 value set\(s\) the translation does not: 1\.2\.3\.4\.5\.6/);
  assert.match(strict.logs.join("\n"), /no HQMF in the directory, so no declaration is excused/);

  // The specification lists the measure's sets only: the shared library's declaration is excused, by name.
  writeFileSync(join(dir, "Main-QDM.xml"), hqmf(REQUIRED));
  assert.deepEqual(measureSpecOids(dir), { oids: new Set(REQUIRED), files: 1 });
  const excused = setup(f);
  assert.equal(await main(deckArgs(f, "--package-cql-dir", "pkg"), excused.deps), 0, excused.errors.join("\n"));
  assert.match(excused.logs.join("\n"), /info: 1 value set\(s\) the package's CQL declares are not in the translation and not in the measure specification \(a shared library's own, unused by the measure\): 1\.2\.3\.4\.5\.6/);

  // The specification lists it: the measure uses it, so the translation must declare it.
  writeFileSync(join(dir, "Main-QDM.xml"), hqmf([...REQUIRED, "1.2.3.4.5.6"]));
  const listed = setup(f);
  assert.equal(await main(deckArgs(f, "--package-cql-dir", "pkg"), listed.deps), 1);
  assert.match(listed.errors.join("\n"), /the package declares 1 value set\(s\) the translation does not: 1\.2\.3\.4\.5\.6/);

  // A set the specification lists that no CQL declares and the translation lacks is a failure too.
  writeFileSync(join(dir, "Main-QDM.xml"), hqmf([...REQUIRED, "7.7.7.7"]));
  const specOnly = setup(f);
  assert.equal(await main(deckArgs(f, "--package-cql-dir", "pkg"), specOnly.deps), 1);
  assert.match(specOnly.errors.join("\n"), /the package's measure specification lists 1 value set\(s\) the translation does not declare: 7\.7\.7\.7/);
});

test("a deck that names no release needs --release", async () => {
  const f = fixture({ deckTitle: "Test bundle" });
  const { deps, errors } = setup(f);
  assert.equal(await main(deckArgs(f), deps), 2);
  assert.match(errors.join("\n"), /--release is required/);
  assert.equal(await main(deckArgs(f, "--release", RELEASE), setup(f).deps), 0);
});

// ---- MADiE ----------------------------------------------------------------------------------------------

test("--madie alone needs no deck, no package and no sidecar, and compares the translation with CMS's logic", async () => {
  const f = fixture({ sidecar: false });
  const { deps, logs, errors, madieCalls, deckCalls } = setup(f);
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], deps), 0, errors.join("\n"));
  assert.deepEqual(
    madieCalls.map((c) => [c.measureUrl === FIXTURE_URL ? "translation" : "cms", c.keptValueSet, c.broken]),
    [
      ["cms", true, false],
      ["translation", true, false],
      ["translation", true, true],
    ],
    "CMS's bundle, then the translation over CMS's ValueSets, then the translation broken",
  );
  assert.equal(deckCalls.length, 0);
  assert.match(logs.join("\n"), /NOTICE no --cypress-bundle/);
  assert.match(logs.join("\n"), /madie 2 cases · status 2 · rates 2 · stratifiers 2 · define values 8\/8 equal — PASS/);
  assert.match(logs.join("\n"), /2 case\(s\) move/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

test("--madie fails on a define value that differs, on too few values, and on a break that moves nothing", async () => {
  const f = fixture({ sidecar: false });
  const differs = setup(f, { runCases: madieStub([], { sexOnTranslation: "M" }) });
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], differs.deps), 1);
  assert.match(differs.errors.join("\n"), /madie: 4 define value\(s\) differ/);

  const tooFew = setup(f, { pinnedStatements: { cms137: 9 } });
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], tooFew.deps), 1);
  assert.match(tooFew.errors.join("\n"), /compared 8 define values, at least 9 required/);

  const blind = setup(f, { runCases: madieStub([], { honourBreak: false }) });
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], blind.deps), 1);
  assert.match(blind.errors.join("\n"), /breaking the translation moved no case/);

  const strataDiffer = setup(f, { runCases: madieStub([], { strataOnTranslation: false }) });
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], strataDiffer.deps), 1);
  assert.match(strataDiffer.errors.join("\n"), /madie: stratifiers differ on 2 case\(s\)/);

  const engineError = setup(f, { runCases: madieStub([], { calculationErrorOnTranslation: "Missing the following valuesets" }) });
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], engineError.deps), 1);
  assert.match(engineError.errors.join("\n"), /madie: calculation error: Missing the following valuesets/);

  const shrunk = setup(f, { requiredCases: { cms137: 3 } });
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], shrunk.deps), 1);
  assert.match(shrunk.errors.join("\n"), /madie: deck has 2 cases, at least 3 required/);
});

test("--madie refuses a measure with no pinned MADiE define count", async () => {
  const f = fixture({ sidecar: false });
  mkdirSync(join(f.root, "derived", "cms68"));
  writeFileSync(join(f.root, "derived", "cms68", "bundle.json"), readFileSync(join(f.dir, "bundle.json")));
  const { deps, errors, madieCalls } = setup(f);
  const translation = deps.loadDerived!("cms137");
  assert.equal(await main(["--catalog-id", "cms68", "--madie"], { ...deps, loadDerived: () => translation }), 1);
  assert.match(errors.join("\n"), /madie: cms68 has no pinned MADiE define count/);
  assert.equal(madieCalls.length, 0);
});

// ---- refusals that need no oracle to run ------------------------------------------------------------------

test("a manifest that is not a translation's, a measure production refuses, or a translation with no period is refused", async () => {
  const f = fixture();
  const notTranslation = setup(f, { loadDerived: () => official });
  assert.equal(await main(deckArgs(f), notTranslation.deps), 1);
  assert.match(notTranslation.errors.join("\n"), /no WorkWell translation loads from measures\/derived\/cms137\//);

  const noSemantics = setup(f, { semantics: () => undefined });
  assert.equal(await main(deckArgs(f), noSemantics.deps), 1);
  assert.match(noSemantics.errors.join("\n"), /no recorded official semantics for cms137/);

  const periodless = setup(f);
  const translation = periodless.deps.loadDerived!("cms137")!;
  const noPeriod = { ...translation, manifest: { ...translation.manifest, effectivePeriod: null } };
  assert.equal(await main(deckArgs(f), { ...periodless.deps, loadDerived: () => noPeriod }), 1);
  assert.match(periodless.errors.join("\n"), /the translation declares no effectivePeriod/);
});

test("CMS's artifact, both sidecars, the terminology pin and the CSV must all be there before any oracle runs", async () => {
  const f = fixture();
  const cases: Array<[string, Partial<DerivedCheckDeps>, RegExp, string[]?]> = [
    ["no CMS artifact", { loadOfficial: () => null }, /CMS's artifact for cms137 does not load/],
    ["the translation's sidecar will not load", { loadTerminology: (a) => (a.kind === "derived" ? { ok: false, problem: "unreadable" } : { ok: true, codesByOid: OFFICIAL_CODES }) }, /the translation's terminology does not load: unreadable/],
    ["CMS's sidecar will not load", { loadTerminology: (a) => (a.kind === "derived" ? setup(f).deps.loadTerminology!(a) : { ok: false, problem: "absent" }) }, /CMS's terminology for cms137 does not load: absent/],
    ["the CSV is missing", {}, /the value-set CSV is missing/, ["--csv", "nowhere.csv"]],
  ];
  for (const [label, over, message, extra] of cases) {
    const calls: DeckCall[] = [];
    const { deps, errors } = setup(f, { calculate: deckStub(calls), ...over });
    assert.equal(await main(deckArgs(f, ...(extra ?? [])), deps), 1, label);
    assert.match(errors.join("\n"), message, label);
    if (label !== "the CSV is missing") assert.equal(calls.length, 0, `${label}: no oracle ran`);
  }

  const unpinned = setup(f);
  const translation = unpinned.deps.loadDerived!("cms137")!;
  const { terminology: _dropped, ...withoutPin } = translation.manifest;
  assert.equal(await main(deckArgs(f), { ...unpinned.deps, loadDerived: () => ({ ...translation, manifest: withoutPin }) }), 1);
  assert.match(unpinned.errors.join("\n"), /the translation's manifest pins no terminology sidecar/);
});

test("files rewritten while the check ran are not vouched for", async () => {
  // The bundle changes under the check: the deck ran on the old bytes, so no record may name the new ones.
  const f = fixture();
  const calls: DeckCall[] = [];
  const stub = deckStub(calls);
  const rewriting: AgreementCalculate = async (input) => {
    if (calls.length === 0) writeFileSync(join(f.dir, "bundle.json"), `${readFileSync(join(f.dir, "bundle.json"), "utf8")} `);
    return stub(input);
  };
  const before = readFileSync(f.manifestPath, "utf8");
  const { deps, errors } = setup(f, { calculate: rewriting });
  assert.equal(await main(recordArgs(f), deps), 1);
  assert.match(errors.join("\n"), /the translation's files changed on disk while the check ran/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);

  // The manifest's pins change under the check: the record would sit beside pins it never ran against.
  const g = fixture();
  const gCalls: DeckCall[] = [];
  const gStub = deckStub(gCalls);
  const repinning: AgreementCalculate = async (input) => {
    if (gCalls.length === 0) {
      const m = JSON.parse(readFileSync(g.manifestPath, "utf8")) as OfficialManifest;
      writeFileSync(g.manifestPath, `${JSON.stringify({ ...m, sha256: `sha256:${"1".repeat(64)}` }, null, 2)}\n`);
    }
    return gStub(input);
  };
  const second = setup(g, { calculate: repinning });
  const repinned = readFileSync(g.manifestPath, "utf8");
  assert.equal(await main(recordArgs(g), second.deps), 1);
  assert.match(second.errors.join("\n"), /manifest\.json on disk no longer pins the files the check ran against/);
  assert.notEqual(readFileSync(g.manifestPath, "utf8"), repinned, "sanity: the stub did rewrite it");
  assert.doesNotMatch(readFileSync(g.manifestPath, "utf8"), /terminology-equivalence/, "and nothing was recorded into it");
});

test("--madie runs the translation's main library with CMS's upstream shared libraries, localIds included", async () => {
  const f = fixture({ sidecar: false });
  const { deps, errors, madieCalls } = setup(f);
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], deps), 0, errors.join("\n"));
  const translationMain = mainLibraryName(base.bundle as never);
  const cmsMain = mainLibraryName(upstreamBundle as never);
  const upstreamLibraries = new Map(upstreamBundle.entry.filter((e) => e.resource.resourceType === "Library").map((e) => [String(e.resource["name"]), JSON.stringify(e.resource)]));
  const translationLibraries = new Map(base.bundle.entry.filter((e) => e.resource["resourceType"] === "Library").map((e) => [String(e.resource["name"]), JSON.stringify(e.resource)]));
  const shared = [...translationLibraries.keys()].filter((name) => name !== translationMain);
  assert.equal(shared.length, 6, "sanity: the fixture carries CMS137's six shared libraries");

  const [, ran, ranBroken] = madieCalls;
  assert.equal(ran!.measureUrl, FIXTURE_URL);
  assert.deepEqual([...ran!.libraries.keys()].sort(), [translationMain, ...shared].sort(), "the translation's main library and its shared ones, never CMS's main");
  assert.equal(ran!.libraries.get(translationMain), translationLibraries.get(translationMain), "the main library is the translation's, byte for byte");
  for (const name of shared) {
    assert.equal(ran!.libraries.get(name), upstreamLibraries.get(name), `${name} is upstream's copy`);
    assert.notEqual(ran!.libraries.get(name), translationLibraries.get(name), `${name}: not the carried copy`);
    const elm = (JSON.parse(ran!.libraries.get(name)!) as { content: Array<{ contentType: string; data: string }> }).content.find((c) => c.contentType === "application/elm+json")!.data;
    assert.match(Buffer.from(elm, "base64").toString("utf8"), /"localId":/, `${name}: runs with upstream's localIds`);
  }
  assert.ok(!ran!.libraries.has(cmsMain), "CMS's main library is not run as the translation");
  for (const name of shared) assert.equal(ranBroken!.libraries.get(name), upstreamLibraries.get(name), `the break run substitutes ${name} too`);
});

test("--madie refuses a carried shared library that is not upstream's once stripped, or that upstream lacks", async () => {
  const f = fixture({ sidecar: false });
  // A real logic difference in a shared library: one define's expression replaced.
  const altered = upstreamWith((libraries) =>
    editElm(libraries.get("Status")!, (elm) => {
      const def = elm.library.statements.def.find((d) => d["expression"] !== undefined)!;
      def["expression"] = { type: "Null" };
    }),
  );
  const status = String(base.bundle.entry.find((e) => e.resource["name"] === "Status")!.resource["version"]);
  const differs = setup(f, { loadCases: () => loadedCases(undefined, undefined, altered) });
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], differs.deps), 1);
  // A string match, for the same reason as above: the version is data, never regex source.
  assert.ok(
    differs.errors.join("\n").includes(`shared library Status|${status} differs from CMS's upstream copy once annotation, locator and localId are stripped`),
    `expected the altered shared library to be refused by name; got:\n${differs.errors.join("\n")}`,
  );
  assert.equal(differs.madieCalls.length, 0, "refused before fqm ran at all");

  const missing = upstreamWith((_libraries, bundle) => {
    bundle.entry = bundle.entry.filter((e) => e.resource["name"] !== "Hospice");
  });
  const absent = setup(f, { loadCases: () => loadedCases(undefined, undefined, missing) });
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], absent.deps), 1);
  assert.match(absent.errors.join("\n"), /shared library Hospice\|[^ ]+ is carried by the translation but absent from CMS's upstream bundle/);
  assert.equal(absent.madieCalls.length, 0);
});

test("--madie still refuses a bundle.json that is not the pinned one", async () => {
  const f = fixture({ sidecar: false, stalePins: true });
  const { deps, errors, madieCalls } = setup(f);
  assert.equal(await main(["--catalog-id", "cms137", "--madie"], deps), 1);
  assert.match(errors.join("\n"), /bundle\.json on disk hashes to/);
  assert.equal(madieCalls.length, 0);
});

// ---- #779: changed libraries, the exact list of expected differences, and edit cases ----------------------

const MADIE = ["--catalog-id", "cms137", "--madie"];
const libraryJson = (bundle: { entry: Array<{ resource: Record<string, unknown> }> }) =>
  new Map(bundle.entry.filter((e) => e.resource["resourceType"] === "Library").map((e) => [String(e.resource["name"]), JSON.stringify(e.resource)]));

/** A check on the changed-library fixture: three defines per group per case, so 12 compared values. */
function changedSetup(f: Fixture, stub: MadieStubOptions = {}, over: Partial<DerivedCheckDeps> = {}) {
  const calls: MadieCall[] = [];
  const s = setup(f, { runCases: madieStub(calls, { changed: true, ...stub }), pinnedStatements: { cms137: 12 }, ...over });
  return { ...s, calls };
}

/** Whether `run` threw an Error whose message contains `text` (data is never made into regex source). */
const throwsWith = (run: () => unknown, text: string) =>
  assert.throws(run, (e: unknown) => e instanceof Error && e.message.includes(text), `expected an error containing: ${text}`);

test("translatedUpstreamBundle runs a changed library as the translation's own copy, and refuses the two bad shapes", () => {
  const translation = changedTranslation(true);
  const block = translation.manifest.derived!;
  const out = translatedUpstreamBundle(upstreamBundle, translation.bundle, block);
  const ran = libraryJson(out as never);
  const ours = libraryJson(translation.bundle as never);
  const theirs = libraryJson(upstreamBundle as never);
  assert.equal(ran.get(CHANGED.name), ours.get(CHANGED.name), "the changed library is the translation's, byte for byte");
  assert.ok(!ran.has("Hospice"), "CMS's copy of the edited library does not run beside it");
  const shared = [...ours.keys()].filter((name) => name !== CHANGED.name && name !== mainLibraryName(translation.bundle as never));
  assert.equal(shared.length, 5, "sanity: the other five shared libraries");
  for (const name of shared) assert.equal(ran.get(name), theirs.get(name), `${name} is still upstream's copy`);

  const id = `${CHANGED.name}|${CHANGED.version}`;
  throwsWith(
    () => translatedUpstreamBundle(upstreamBundle, translation.bundle, { changedLibraries: [{ ...CHANGED_ENTRY, from: { ...CHANGED_ENTRY.from, version: "0.0.1" } }] }),
    `changed library ${id} was edited from Hospice|0.0.1, which CMS's upstream bundle does not hold`,
  );
  throwsWith(
    () => translatedUpstreamBundle(upstreamBundle, translation.bundle, { changedLibraries: [{ ...CHANGED_ENTRY, name: "WorkWellNotCarried" }] }),
    `changed library WorkWellNotCarried|${CHANGED.version} is listed in changedLibraries, but the translation does not carry it`,
  );
  // Dropped from the manifest, the copy is just a shared library CMS never shipped.
  throwsWith(() => translatedUpstreamBundle(upstreamBundle, translation.bundle, {}), `shared library ${id} is carried by the translation but absent from CMS's upstream bundle`);
});

test("the edited define is found by comparing ELM with CMS's, and the break forces exactly it to null", () => {
  const edited = changedTranslation(true);
  const library = (bundle: OfficialArtifact["bundle"]) => bundle.entry.map((e) => e.resource as Record<string, unknown>).find((r) => r["name"] === CHANGED.name)!;
  const cmsHospice = upstreamBundle.entry.map((e) => e.resource).find((r) => r["name"] === "Hospice")!;
  // Upstream's copy carries localIds and a library annotation; neither is a difference.
  assert.deepEqual(differingDefines(elmOf(library(edited.bundle)) as never, elmOf(cmsHospice) as never), [{ key: `define ${HOSPICE_DEFINE}`, name: HOSPICE_DEFINE, in: "both" }]);
  assert.deepEqual(differingDefines(elmOf(library(changedTranslation(false).bundle)) as never, elmOf(cmsHospice) as never), [], "an unedited copy differs in nothing");
  const typed = elmOf(library(changedTranslation(false).bundle));
  for (const def of typed.library.statements.def) def["resultTypeName"] = "{urn:hl7-org:elm-types:r1}Any";
  assert.deepEqual(differingDefines(typed as never, elmOf(cmsHospice) as never), [], "a result-type annotation is not logic");

  const before = JSON.stringify(edited.bundle);
  const { bundle, broken, differing } = withChangedLibraryBroken(edited.bundle, upstreamBundle, CHANGED_ENTRY);
  assert.deepEqual(broken, [`define ${HOSPICE_DEFINE}`]);
  assert.equal(differing.length, 1);
  assert.equal(defExpressionType(library(bundle), HOSPICE_DEFINE), "Null");
  assert.equal(defExpressionType(library(bundle), "Patient"), defExpressionType(library(edited.bundle), "Patient"), "an unedited define is left alone");
  assert.equal(JSON.stringify(edited.bundle), before, "a copy is broken, never the translation");
  assert.deepEqual(withChangedLibraryBroken(changedTranslation(false).bundle, upstreamBundle, CHANGED_ENTRY).broken, []);
});

test("--madie on a changed library: the listed differences pass exactly, both breaks move results, the edit cases agree", async () => {
  const f = fixture({ sidecar: false, changed: "edited" });
  const { deps, logs, errors, calls } = changedSetup(f);
  assert.equal(await main(MADIE, deps), 0, errors.join("\n"));
  const text = logs.join("\n");
  assert.match(text, /define values 10\/12 equal · listed differences 2\/2 observed, 0 unlisted — PASS/);
  assert.match(text, /"Initial Population" forced false → 2 case\(s\) move/);
  assert.ok(
    text.includes(
      `${CHANGED.name} (WorkWell's edit of Hospice ${HOSPICE_VERSION}): 1 edited def(s) forced null (define ${HOSPICE_DEFINE}) → ` +
        "4 define value(s) move, 4 of them the edited define(s) (the check runs WorkWell's copy)",
    ),
    text,
  );
  assert.match(text, /edit cases: 1 of 2 expect a different answer from the translation than from CMS's logic · period 2026-01-01\.\.2026-12-31/);
  assert.match(text, /cms137: edit cases 2 · CMS's logic 2\/2 · translation 2\/2 — PASS/);
  assert.deepEqual(
    calls.map((c) => [c.measureUrl === FIXTURE_URL ? "translation" : "cms", c.broken, c.changedBroken, c.cases.join(",")]),
    [
      ["cms", false, false, "c1,c2"],
      ["translation", false, false, "c1,c2"],
      ["translation", true, false, "c1,c2"],
      ["translation", false, true, "c1,c2"],
      ["cms", false, false, "e1,e2"],
      ["translation", false, false, "e1,e2"],
    ],
    "the deck on both logics, the two breaks, then the edit cases on both logics",
  );
  assert.ok(calls[0]!.libraries.has("Hospice") && !calls[0]!.libraries.has(CHANGED.name), "CMS's run has CMS's library");
  assert.ok(calls[1]!.libraries.has(CHANGED.name) && !calls[1]!.libraries.has("Hospice"), "the translation's run has WorkWell's copy alone");
  assert.ok(calls[5]!.libraries.has(CHANGED.name), "the edit cases run the translation with WorkWell's copy");
});

test("--madie: the define-value differences must equal the listed ones exactly", async () => {
  const run = async (expectedDifferences: unknown) => {
    const s = changedSetup(fixture({ sidecar: false, changed: "edited", expectedDifferences }));
    const code = await main(MADIE, s.deps);
    return { code, errors: s.errors.join("\n"), logs: s.logs.join("\n"), calls: s.calls };
  };

  const none = await run(null);
  assert.equal(none.code, 1);
  assert.ok(none.errors.includes("madie: 2 define value(s) differ, and no madie-expected-differences.json lists any"), none.errors);
  assert.ok(none.logs.includes(`unlisted difference: case c1 g0|Hospice.${HOSPICE_DEFINE}: CMS's false|"NA"|NA · ours true|"NA"|NA`), none.logs);

  const short = await run([LISTED[0]]);
  assert.equal(short.code, 1);
  assert.ok(short.errors.includes("madie: 1 define value(s) differ that madie-expected-differences.json does not list"), short.errors);
  assert.ok(!short.errors.includes("not observed"));

  const extra = await run([...LISTED, { ...LISTED[0]!, case: "c2" }]);
  assert.equal(extra.code, 1);
  assert.ok(extra.errors.includes("madie: 1 difference(s) madie-expected-differences.json lists were not observed"), extra.errors);
  assert.ok(extra.logs.includes(`listed difference not observed: case c2 g0|Hospice.${HOSPICE_DEFINE}`), extra.logs);
  assert.match(extra.logs, /listed differences 2\/3 observed, 0 unlisted — FAIL/);

  // The right define on the right case, but not the value listed: one missing, one unlisted.
  const moved = await run([{ ...LISTED[0]!, ours: '"something else"|"NA"|NA' }, LISTED[1]]);
  assert.equal(moved.code, 1);
  assert.ok(moved.errors.includes("1 define value(s) differ that madie-expected-differences.json does not list"), moved.errors);
  assert.ok(moved.errors.includes("1 difference(s) madie-expected-differences.json lists were not observed"), moved.errors);

  const unexplained = await run([{ ...LISTED[0]!, reason: "  " }, LISTED[1]]);
  assert.equal(unexplained.code, 1);
  assert.ok(unexplained.errors.includes("madie: madie-expected-differences.json: entry 1 has no reason"), unexplained.errors);
  assert.equal(unexplained.calls.length, 0, "refused before fqm ran");

  // A translation with no difference at all (cms137) and a file listing one: the listed one is not seen.
  const f = fixture({ sidecar: false, expectedDifferences: [{ case: "c1", key: "g0|M.D", cms: "true", ours: "false", reason: "r" }] });
  const unchanged = setup(f);
  assert.equal(await main(MADIE, unchanged.deps), 1);
  assert.ok(unchanged.errors.join("\n").includes("madie: 1 difference(s) madie-expected-differences.json lists were not observed"));
});

test("an expected-differences file is a set of exact, explained differences", () => {
  const ok = { case: "c1", key: "g0|Lib.Define", cms: "false", ours: "true", reason: "why" };
  assert.equal(parseExpectedDifferences([ok, { ...ok, key: "g1|Lib.Define", ours: null }]).length, 2);
  const refusals: Array<[unknown, string]> = [
    [{}, "not a JSON array"],
    [[{ ...ok, extra: 1 }], "unknown key(s) extra"],
    [[{ ...ok, reason: "" }], "entry 1 has no reason"],
    [[{ ...ok, ours: "false" }], "cms and ours are equal"],
    [[{ ...ok, cms: null, ours: null }], "cms and ours are equal"],
    [[{ ...ok, cms: false }], "cms must be the compared string"],
    [[{ ...ok, key: "Lib.Define" }], "g<group>|<library>.<define>"],
    [[ok, { ...ok }], "entry 2 repeats an earlier entry"],
  ];
  for (const [bad, message] of refusals) throwsWith(() => parseExpectedDifferences(bad), message);
  const d = (k: string) => ({ case: "c", key: k, cms: "a", ours: "b" });
  assert.deepEqual(matchExpectedDifferences([d("g0|L.x"), d("g0|L.y")], [d("g0|L.y"), d("g0|L.z")]), { missing: [d("g0|L.z")], unexpected: [d("g0|L.x")] });
  assert.deepEqual(matchExpectedDifferences([d("g0|L.x"), d("g0|L.x")], [d("g0|L.x")]), { missing: [], unexpected: [d("g0|L.x")] }, "a multiset: seen twice, listed once");
});

test("--madie: a changed-library break that moves nothing fails, and so does an edit that changed no define", async () => {
  const blind = changedSetup(fixture({ sidecar: false, changed: "edited" }), { honourChangedBreak: false });
  assert.equal(await main(MADIE, blind.deps), 1);
  const what = `${CHANGED.name} (WorkWell's edit of Hospice ${HOSPICE_VERSION})`;
  assert.ok(blind.errors.join("\n").includes(`madie: breaking ${what} moved no define value: the check is not running WorkWell's copy`), blind.errors.join("\n"));
  assert.ok(blind.logs.join("\n").includes("→ 0 define value(s) move, 0 of them the edited define(s) — FAIL"));

  // CMS's logic under WorkWell's name: there is no edit to prove, and the check says so rather than pass.
  const unedited = changedSetup(fixture({ sidecar: false, changed: "unedited", expectedDifferences: LISTED }));
  assert.equal(await main(MADIE, unedited.deps), 1);
  assert.ok(unedited.errors.join("\n").includes(`madie: ${what} differs from CMS's copy in no define: an edit that changed nothing`), unedited.errors.join("\n"));
  assert.ok(!unedited.calls.some((c) => c.changedBroken), "no break run for a library with nothing to break");
});

test("--madie: edits.json decides whether edit cases are owed, and the files must agree with it", async () => {
  const refused = async (f: Fixture, text: string) => {
    const s = changedSetup(f);
    assert.equal(await main(MADIE, s.deps), 1, text);
    assert.ok(s.errors.join("\n").includes(text), `expected '${text}' in:\n${s.errors.join("\n")}`);
    assert.equal(s.calls.length, 0, `${text}: refused before fqm ran`);
  };
  await refused(fixture({ sidecar: false, edits: null }), "madie: edits.json is missing from measures/derived/cms137/: a translation states its edits, [] for none");
  await refused(fixture({ sidecar: false, edits: { not: "an array" } }), "madie: edits.json is not a JSON array");
  await refused(fixture({ sidecar: false, changed: "edited", edits: [] }), "madie: the manifest lists 1 changed library but edits.json is [], so no edit case would run");
  await refused(fixture({ sidecar: false, editCases: EDIT_CASES }), "madie: edit-cases.json is present but edits.json is []");
  await refused(fixture({ sidecar: false, changed: "edited", editCases: null }), "madie: edit-cases.json is missing: edits.json holds 1 edit(s)");
  await refused(fixture({ sidecar: false, changed: "edited", editCases: { ...EDIT_CASES, cases: [] } }), "madie: edit cases: edit-cases.json holds no case");
  const same = { ...EDIT_CASES, cases: EDIT_CASES.cases.map((c) => ({ ...c, expected: { cms: c.expected.cms, translation: c.expected.cms } })) };
  await refused(fixture({ sidecar: false, changed: "edited", editCases: same }), "madie: edit cases: none of the 2 edit case(s) expects a different answer from the translation than from CMS's logic");
  await refused(
    fixture({ sidecar: false, changed: "edited", editCases: { ...EDIT_CASES, measurementPeriod: { start: "2027-01-01", end: "2027-12-31" } } }),
    "madie: edit cases: edit-cases.json is written for 2027-01-01..2027-12-31, but the MADiE deck runs 2026-01-01..2026-12-31",
  );
  // A case that states fewer populations than cms137 declares is refused by name, not compared as zeros.
  const partial = { ...EDIT_CASES, cases: [{ ...EDIT_CASES.cases[0]!, expected: { cms: [{ "initial-population": 1 }, stated(0)], translation: [stated(1), stated(1)] } }] };
  await refused(fixture({ sidecar: false, changed: "edited", editCases: partial }), "madie: edit-cases.json: case e1 expected.cms[0] must state denominator as 0 or 1");
});

test("--madie: every edit case must agree on both logics, counted rather than assumed", async () => {
  const run = async (stub: MadieStubOptions) => {
    const s = changedSetup(fixture({ sidecar: false, changed: "edited" }), stub);
    const code = await main(MADIE, s.deps);
    return { code, errors: s.errors.join("\n"), logs: s.logs.join("\n") };
  };
  const both = "IPP 1 DENOM 1 DENEX 1 NUMER 0 | IPP 1 DENOM 1 DENEX 1 NUMER 0";
  const neither = "IPP 1 DENOM 1 DENEX 0 NUMER 0 | IPP 1 DENOM 1 DENEX 0 NUMER 0";
  // The harness returns a case it cannot score with no agreement at all; it must not count as a pass.
  const skipped = await run({ skipEditCase: "e2" });
  assert.equal(skipped.code, 1);
  assert.ok(skipped.errors.includes("madie: edit cases: CMS's logic: 1/2 edit case(s) agree"), skipped.errors);
  assert.ok(skipped.errors.includes("madie: edit cases: the translation: 1/2 edit case(s) agree"), skipped.errors);
  assert.ok(skipped.logs.includes(`edit case e2 on CMS's logic: expected ${both}; not scored (no agreement)`), skipped.logs);
  assert.match(skipped.logs, /cms137: edit cases 2 · CMS's logic 1\/2 · translation 1\/2 — FAIL/);

  const dropped = await run({ dropEditCase: "e1" });
  assert.equal(dropped.code, 1);
  assert.ok(dropped.errors.includes("madie: edit cases: CMS's logic: 1 case result(s) for 2 edit case(s)"), dropped.errors);
  assert.ok(dropped.logs.includes(`edit case e1 on CMS's logic: expected ${neither}; 0 results`), dropped.logs);

  // The edit did not take: the translation answers CMS's way. Only the discriminating case catches it.
  const lost = await run({ editLostOnTranslation: true });
  assert.equal(lost.code, 1);
  assert.ok(lost.errors.includes("madie: edit cases: the translation: 1/2 edit case(s) agree"), lost.errors);
  assert.ok(!lost.errors.includes("CMS's logic: 1/2"), "CMS's side still agrees");
  assert.ok(lost.logs.includes(`edit case e1 on the translation: expected ${both}; got ${neither}`), lost.logs);
});

test("sanity: the edit-case fixture states exactly the populations cms137 declares, at the deck's period", () => {
  assert.deepEqual(declaredPopulations(upstreamBundle), [0, 1].map(() => ["initial-population", "denominator", "denominator-exclusion", "numerator"]));
  assert.deepEqual(loadedCases().measurementPeriod, MADIE_PERIOD);
});
