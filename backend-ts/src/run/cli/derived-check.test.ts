/**
 * `derived:check` on a translation written into a TEMPORARY `derived/cms137/` (never `measures/derived/`):
 * the fixture translation from the committed cms137 bundle, a synthetic sidecar, a synthetic Cypress deck
 * and value-set CSV, a stubbed deck calculation and a stubbed MADiE runner. It must refuse bytes that are
 * not the pinned ones, write nothing on any failure, record both oracles against the hashes it computed
 * when everything passes, and run the MADiE comparison with no deck and no sidecar at all.
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
import type { FhirBundle, LoadedOfficialMeasure, OfficialMeasureRun, PopulationCounts, RunOfficialMeasureOptions } from "../../standards/official-cases.ts";
import { derivedCms137, FIXTURE_URL } from "../../test-support/derived-fixture.ts";
import { loadOfficialArtifact, readArtifactDir, type OfficialArtifact, type OfficialManifest } from "../../wiring/official-artifacts.ts";
import { requiredOids } from "../../wiring/official-executor-adapter.ts";
import { verifyTerminology, type LoadedTerminology } from "../../wiring/official-terminology.ts";
import { DerivedCheckUsageError, declaredPackageOids, main, mainLibraryName, parseArgs, type DerivedCheckDeps } from "./derived-check.ts";

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

function fixture(options: { translationCodes?: Codes; stalePins?: boolean; sidecar?: boolean; packageSha?: string; deckTitle?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "derived-check-"));
  const dir = join(root, "derived", "cms137");
  mkdirSync(dir, { recursive: true });
  const bundleText = JSON.stringify(base.bundle);
  writeFileSync(join(dir, "bundle.json"), bundleText);
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
    ...base.manifest,
    sha256: options.stalePins ? base.manifest.sha256 : bundleSha,
    terminology: { ...base.manifest.terminology!, sha256: options.stalePins ? base.manifest.terminology!.sha256 : terminologySha },
    derived: {
      ...base.manifest.derived!,
      derivedFrom: { ecqm: "CMS137v15", packageSha256: options.packageSha ?? sha(PACKAGE_BYTES) },
      oracles: [
        { ...base.manifest.derived!.oracles[0]!, name: "earlier-check" },
        { ...base.manifest.derived!.oracles[0]!, result: "fail", agree: 0 },
      ],
    },
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
}

/**
 * fqm's per-case output for either bundle, with the main library named as the bundle names it — so the
 * translation's defines arrive under its renamed library, exactly as fqm reports them.
 */
function madieStub(
  calls: MadieCall[],
  options: { sexOnTranslation?: string; honourBreak?: boolean; strataOnTranslation?: boolean; calculationErrorOnTranslation?: string } = {},
) {
  return async (loaded: LoadedOfficialMeasure, runOptions: RunOfficialMeasureOptions = {}): Promise<OfficialMeasureRun> => {
    const bundle = loaded.measureBundle as unknown as { entry: Array<{ resource: Record<string, unknown> }> };
    const measure = bundle.entry.find((e) => e.resource["resourceType"] === "Measure")!.resource;
    const translation = String(measure["url"]).startsWith("urn:workwell:");
    const broken = ippBroken(bundle) && options.honourBreak !== false;
    calls.push({
      measureUrl: measure["url"],
      keptValueSet: bundle.entry.some((e) => e.resource["id"] === "kept"),
      broken,
      libraries: new Map(bundle.entry.filter((e) => e.resource["resourceType"] === "Library").map((e) => [String(e.resource["name"]), JSON.stringify(e.resource)])),
    });
    const main = mainLibraryName(bundle);
    const output = {
      results: loaded.cases.map((c, i) => ({
        patientId: c.patientId,
        detailedResults: [0, 1].map(() => ({
          populationResults: [],
          statementResults: [
            { libraryName: main, statementName: "Numerator", raw: !broken && i === 0, final: "TRUE", relevance: "TRUE" },
            { libraryName: "SupplementalDataElements", statementName: "SDE Sex", raw: translation && options.sexOnTranslation ? options.sexOnTranslation : "F", final: "NA", relevance: "NA" },
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
      measure: "cms137",
      measureName: loaded.measureName,
      measurementPeriod: loaded.measurementPeriod,
      valueSets: loaded.valueSets,
      valueSetMode: "measure-bundle",
      supplementedOids: [],
      trustMetaProfile: false,
      profileRetry: false,
      retrieveSignal: true,
      engineWarnings: 0,
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
});

// ---- the full check -------------------------------------------------------------------------------------

test("--record on a pass writes both records against the hashes it computed, keeping everything else", async () => {
  const f = fixture();
  const { deps, logs, errors, deckCalls } = setup(f);
  const before = readFileSync(f.manifestPath, "utf8");
  const code = await main(deckArgs(f, "--record"), deps);
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
  assert.match(logs.join("\n"), /NOTICE \*+ no --package-cql-dir/);
  rmSync(f.root, { recursive: true, force: true });
});

test("without --record a pass writes nothing", async () => {
  const f = fixture();
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(deckArgs(f), setup(f).deps), 0);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

test("bytes on disk that are not the pinned ones are refused", async () => {
  const f = fixture({ stalePins: true });
  const { deps, errors, deckCalls } = setup(f);
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(deckArgs(f, "--record"), deps), 1);
  assert.match(errors.join("\n"), /bundle\.json on disk hashes to sha256:[0-9a-f]{64}, the manifest pins sha256:e{64}/);
  assert.equal(deckCalls.length, 0, "nothing ran");
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);

  // A sidecar whose bytes moved after the pin was taken: the bundle matches, the terminology does not.
  const g = fixture();
  writeFileSync(join(g.dir, "terminology.json"), "{}");
  const second = setup(g);
  assert.equal(await main(deckArgs(g, "--record"), second.deps), 1);
  assert.match(second.errors.join("\n"), /terminology\.json on disk hashes to/);
});

test("a failing deck oracle exits 1 and leaves manifest.json untouched", async () => {
  const f = fixture();
  const flipped = { ...ANSWERS, p2: { ...ANSWERS["p2"]!, rates: [pops(true, true), pops(true, false)] } };
  const calls: DeckCall[] = [];
  const { deps, errors } = setup(f, { calculate: deckStub(calls, flipped) });
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(deckArgs(f, "--record"), deps), 1);
  assert.match(errors.join("\n"), /cypress-deck: 1\/2 patients agree on every row/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

test("an oracle that cannot see the break fails, however well it agrees", async () => {
  const f = fixture();
  const { deps, errors } = setup(f, { calculate: deckStub([], ANSWERS, false) });
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(deckArgs(f, "--record"), deps), 1);
  assert.match(errors.join("\n"), /breaking the translation did not lower agreement/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

test("a translation whose codes differ from the release fails terminology-equivalence and records nothing", async () => {
  // The first set re-expanded without the code the release added.
  const f = fixture({ translationCodes: new Map([...RELEASE_CODES].map(([oid, codes]) => [oid, codes.filter((c) => c.code !== "T0NEW")])) });
  const { deps, errors, logs } = setup(f);
  const before = readFileSync(f.manifestPath, "utf8");
  assert.equal(await main(deckArgs(f, "--record"), deps), 1);
  assert.match(errors.join("\n"), new RegExp(`terminology-equivalence: 1 declared value set\\(s\\) differ from the CSV: ${REQUIRED[0]!.replace(/\./g, "\\.")}`));
  assert.match(logs.join("\n"), /missing 1, extra 0\) — DIFFERS/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});

test("a package that is not the one translated from is refused", async () => {
  const f = fixture({ packageSha: `sha256:${"0".repeat(64)}` });
  const { deps, errors, deckCalls } = setup(f);
  assert.equal(await main(deckArgs(f, "--record"), deps), 1);
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
  assert.equal(await main(deckArgs(f, "--record"), deps), 1);
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
  assert.equal(await main(deckArgs(g, "--record"), second.deps), 1);
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
  assert.match(differs.errors.join("\n"), new RegExp(`shared library Status\\|${status.replace(/\./g, "\\.")} differs from CMS's upstream copy once annotation, locator and localId are stripped`));
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
