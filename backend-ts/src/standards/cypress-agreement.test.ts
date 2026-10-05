/**
 * The Cypress agreement comparison, on a synthetic deck: what "agree" means per rate and per stratum,
 * that a flipped expected value or a misplaced stratum is seen, that engine errors and uncompared rows
 * can never pass, and that a translation is run as itself. The real (licensed) deck never enters the
 * repository; its counts are measured with `scripts/cvu/bundle-agreement.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { derivedCms137, FIXTURE_URL } from "../test-support/derived-fixture.ts";
import { loadOfficialArtifact } from "../wiring/official-artifacts.ts";
import {
  agreementCli,
  agreementPasses,
  AgreementUsageError,
  deckValueSetRelease,
  importDeckPatients,
  parseAgreementArgs,
  readCypressDeck,
  renderAgreementMarkdown,
  rowsAgreeing,
  runAgreement,
  type AgreementCalculate,
  type AgreementReport,
  type AgreementSubjectResult,
  type CypressDeck,
} from "./cypress-agreement.ts";

type Values = Partial<Record<"IPP" | "DENOM" | "DENEX" | "NUMER", number>>;
interface Row {
  patient: string;
  key: string;
  values: Values;
  measure?: string;
}

const PATIENTS = [
  { id: "p1", given: "Alpha", family: "Synthetic" },
  { id: "p2", given: "Beta", family: "Synthetic Two" },
];

/** A Cypress-shaped bundle directory: metadata, the two mapping CSVs, individual results, patient files. */
function writeSyntheticDeck(rows: readonly Row[], options: { title?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cypress-deck-"));
  mkdirSync(join(dir, "calculations", "individual-results"), { recursive: true });
  mkdirSync(join(dir, "patients"));
  writeFileSync(
    join(dir, "bundle.json"),
    JSON.stringify({
      version: "2026.1.0",
      title: options.title ?? "Test bundle (eCQM value sets as of May 14, 2026)",
      measure_period_start: 1735689600, // 2025-01-01T00:00:00Z
      effective_date: 1767225599, // 2025-12-31T23:59:59Z
    }),
  );
  writeFileSync(join(dir, "calculations", "measure-id-mapping.csv"), "m137,CMS137v15\nm1370,CMS1370v1\n");
  writeFileSync(join(dir, "calculations", "patient-id-mapping.csv"), PATIENTS.map((p) => `${p.id},${p.given},${p.family}`).join("\n") + "\n");
  rows.forEach((row, i) => {
    writeFileSync(
      join(dir, "calculations", "individual-results", `individual-result-${i}.json`),
      JSON.stringify({
        measure_id: row.measure ?? "m137",
        patient_id: row.patient,
        population_set_key: row.key,
        IPP: row.values.IPP ?? 0,
        DENOM: row.values.DENOM ?? 0,
        DENEX: row.values.DENEX ?? 0,
        DENEXCEP: null,
        NUMER: row.values.NUMER ?? 0,
        NUMEX: null,
        STRAT: /Stratification/.test(row.key) ? 1 : null,
      }),
    );
  });
  for (const p of PATIENTS) writeFileSync(join(dir, "patients", `${p.given}_${p.family.replace(/\s+/g, "_")}.xml`), `<placeholder patient="${p.id}"/>`);
  return dir;
}

/** p1 is in both numerators and stratum 1; p2 is in both denominators only and stratum 2. */
const STANDARD_ROWS: Row[] = [
  { patient: "p1", key: "PopulationSet_1", values: { IPP: 1, DENOM: 1, NUMER: 1 } },
  { patient: "p1", key: "PopulationSet_2", values: { IPP: 1, DENOM: 1, NUMER: 1 } },
  { patient: "p1", key: "PopulationSet_1_Stratification_1", values: { IPP: 1, DENOM: 1, NUMER: 1 } },
  { patient: "p1", key: "PopulationSet_2_Stratification_1", values: { IPP: 1, DENOM: 1, NUMER: 1 } },
  { patient: "p2", key: "PopulationSet_1", values: { IPP: 1, DENOM: 1 } },
  { patient: "p2", key: "PopulationSet_2", values: { IPP: 1, DENOM: 1 } },
  { patient: "p2", key: "PopulationSet_1_Stratification_2", values: { IPP: 1, DENOM: 1 } },
  { patient: "p2", key: "PopulationSet_2_Stratification_2", values: { IPP: 1, DENOM: 1 } },
  // Another measure's row: neither compared nor hashed.
  { patient: "p1", key: "PopulationSet_1", values: { IPP: 0 }, measure: "m1370" },
];

/** The importer is injected: a placeholder file becomes a bundle holding one Patient. */
const importDeps = {
  importDocument: (xml: string) => ({
    bundle: { resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", id: `from-${xml.length}` } }] },
    untranslatedTemplates: ["2.16.840.1.113883.10.20.24.3.55"],
  }),
  prepare: (bundle: unknown) => bundle,
};

const pops = (values: Values) =>
  (["initial-population", "denominator", "denominator-exclusion", "numerator"] as const).map((populationType, i) => ({
    populationType,
    result: [values.IPP, values.DENOM, values.DENEX, values.NUMER][i] === 1,
  }));
const strata = (inStratum: number, count = 3) => Array.from({ length: count }, (_, m) => ({ strataId: `Stratification_x_${m + 1}`, result: m === inStratum }));

/** What a correct engine reports for STANDARD_ROWS. */
const STANDARD_ANSWERS: Record<string, AgreementSubjectResult> = {
  p1: { rates: [pops({ IPP: 1, DENOM: 1, NUMER: 1 }), pops({ IPP: 1, DENOM: 1, NUMER: 1 })], strata: [strata(0), strata(0)] },
  p2: { rates: [pops({ IPP: 1, DENOM: 1 }), pops({ IPP: 1, DENOM: 1 })], strata: [strata(1), strata(1)] },
};

const patientIdOf = (bundle: unknown): string =>
  String((bundle as { entry: Array<{ resource: { resourceType: string; id: string } }> }).entry.find((e) => e.resource.resourceType === "Patient")!.resource.id);

function stubCalculate(answers: Record<string, AgreementSubjectResult>, seen: Array<{ measureUrl: unknown; patients: number }> = []): AgreementCalculate {
  return async (input) => {
    const measure = input.bundle.entry.find((e) => e.resource["resourceType"] === "Measure")!.resource;
    seen.push({ measureUrl: measure["url"], patients: input.patientBundles.length });
    return { bySubject: new Map(input.patientBundles.map((b) => [patientIdOf(b), answers[patientIdOf(b)]!] as const).filter(([, a]) => a !== undefined)) };
  };
}

const official = loadOfficialArtifact("cms137")!;

async function agreement(rows: readonly Row[], answers: Record<string, AgreementSubjectResult>, strataMode: "compare" | "count" = "compare", calculate?: AgreementCalculate) {
  const deck = readCypressDeck(writeSyntheticDeck(rows), "cms137");
  const patients = importDeckPatients(deck, importDeps);
  return runAgreement({
    deck,
    patients,
    artifact: official,
    valueSetCache: [],
    trustMetaProfile: false,
    calculate: calculate ?? stubCalculate(answers),
    strata: strataMode,
  });
}

test("the deck reads its own period, measure, rows and release, and hashes only this measure's answer", () => {
  const dir = writeSyntheticDeck(STANDARD_ROWS);
  const deck = readCypressDeck(dir, "cms137");
  assert.deepEqual(deck.period, { start: "2025-01-01", end: "2025-12-31" });
  assert.deepEqual(deck.measure, { bundleId: "m137", name: "CMS137v15" }, "CMS137v15, not CMS1370v1");
  assert.equal(deck.sets.length, 4);
  assert.equal(deck.strata.length, 4);
  assert.deepEqual(deck.strata.map((s) => [s.set, s.stratum]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.deepEqual(deck.patientIds, ["p1", "p2"]);
  assert.equal(deck.meta.release, "eCQM Update 2026-05-14");
  assert.match(deck.inputSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(readCypressDeck(dir, "cms137").inputSha256, deck.inputSha256, "stable across reads");

  const changed = (mutate: (dir: string) => void) => {
    const other = writeSyntheticDeck(STANDARD_ROWS);
    mutate(other);
    return readCypressDeck(other, "cms137").inputSha256;
  };
  assert.equal(changed(() => {}), deck.inputSha256, "the same answer key in another directory hashes the same");
  assert.equal(
    changed((d) => writeFileSync(join(d, "bundle.json"), JSON.stringify({ version: "9", title: "other", measure_period_start: 1735689600, effective_date: 1767225599 }))),
    deck.inputSha256,
    "bundle.json is metadata, not the answer",
  );
  assert.equal(
    changed((d) => writeFileSync(join(d, "calculations", "individual-results", "individual-result-8.json"), JSON.stringify({ measure_id: "m1370", patient_id: "p2", population_set_key: "PopulationSet_1" }))),
    deck.inputSha256,
    "another measure's result is not this measure's answer",
  );
  assert.notEqual(
    changed((d) => writeFileSync(join(d, "calculations", "individual-results", "individual-result-0.json"), JSON.stringify({ measure_id: "m137", patient_id: "p1", population_set_key: "PopulationSet_1", IPP: 0 }))),
    deck.inputSha256,
    "a changed expected value changes the hash",
  );
  assert.notEqual(
    changed((d) => writeFileSync(join(d, "patients", "Alpha_Synthetic.xml"), "<changed/>")),
    deck.inputSha256,
    "a changed patient changes the hash",
  );
  assert.notEqual(
    changed((d) => writeFileSync(join(d, "calculations", "measure-id-mapping.csv"), "m137,CMS137v16\n")),
    deck.inputSha256,
    "the mapping row is part of the answer",
  );
});

test("the release is read from the deck's metadata, or not at all", () => {
  assert.equal(deckValueSetRelease({ title: "Cypress bundle (eCQM value sets as of May 14, 2026)" }), "eCQM Update 2026-05-14");
  assert.equal(deckValueSetRelease({ title: "x", version: "eCQM Update 2025-05-08" }), "eCQM Update 2025-05-08");
  assert.equal(deckValueSetRelease({ title: "Cypress bundle" }), undefined);
  assert.equal(deckValueSetRelease({ title: "value sets as of Smarch 1, 2026" }), undefined);
});

test("every rate and every stratum agrees, and the run passes", async () => {
  const report = await agreement(STANDARD_ROWS, STANDARD_ANSWERS);
  assert.deepEqual(report.sets.map((t) => `${t.agree}/${t.total}`), ["2/2", "2/2"]);
  assert.deepEqual(report.strata.map((t) => `${t.set + 1}.${t.stratum + 1} ${t.agree}/${t.total}`), ["1.1 1/1", "1.2 1/1", "2.1 1/1", "2.2 1/1"]);
  assert.equal(report.patientsAgreeing, 2);
  assert.equal(rowsAgreeing(report), 8);
  assert.ok(agreementPasses(report));
});

test("one flipped expected NUMER lowers agreement and fails the run", async () => {
  const rows = STANDARD_ROWS.map((r) => (r.patient === "p2" && r.key === "PopulationSet_2" ? { ...r, values: { ...r.values, NUMER: 1 } } : r));
  const report = await agreement(rows, STANDARD_ANSWERS);
  assert.deepEqual(report.sets.map((t) => `${t.agree}/${t.total}`), ["2/2", "1/2"]);
  assert.equal(report.sets[1]!.expected["NUMER"], 2);
  assert.equal(report.sets[1]!.reported["NUMER"], 1);
  assert.deepEqual(report.disagreements.map((d) => [d.set, d.stratum, d.patientId, d.diffs]), [[1, undefined, "p2", ["NUMER 1→0"]]]);
  assert.equal(report.patientsAgreeing, 1);
  assert.equal(agreementPasses(report), false);
});

test("a stratum row the engine places in a different stratum disagrees", async () => {
  // Cypress says p2 is in stratifier 2 of rate 1; the engine reports stratifier 1.
  const answers = { ...STANDARD_ANSWERS, p2: { ...STANDARD_ANSWERS["p2"]!, strata: [strata(0), strata(1)] } };
  const report = await agreement(STANDARD_ROWS, answers);
  assert.deepEqual(report.sets.map((t) => `${t.agree}/${t.total}`), ["2/2", "2/2"], "the rates still agree");
  const s12 = report.strata.find((t) => t.set === 0 && t.stratum === 1)!;
  assert.equal(`${s12.agree}/${s12.total}`, "0/1");
  assert.deepEqual(report.disagreements[0]!.diffs, ["stratum 1 0→1", "stratum 2 1→0"]);
  assert.equal(agreementPasses(report), false);

  const unreported = await agreement(STANDARD_ROWS, { ...STANDARD_ANSWERS, p2: { ...STANDARD_ANSWERS["p2"]!, strata: [[], strata(1)] } });
  assert.match(unreported.disagreements[0]!.diffs.join(), /stratum 2 not reported \(0 reported\)/, "a stratum the engine never reports cannot agree");

  // `result` is membership; `appliesResult` is not consulted, so a stratum with appliesResult alone is not membership.
  const appliesOnly = await agreement(STANDARD_ROWS, {
    ...STANDARD_ANSWERS,
    p2: { ...STANDARD_ANSWERS["p2"]!, strata: [[{ result: false }, { result: false, appliesResult: true } as never, { result: false }], strata(1)] },
  });
  assert.equal(appliesOnly.strata.find((t) => t.set === 0 && t.stratum === 1)!.agree, 0);
});

test("strata only counted can never pass, and a stratum's populations are compared too", async () => {
  const counted = await agreement(STANDARD_ROWS, STANDARD_ANSWERS, "count");
  assert.equal(counted.strata.length, 0);
  assert.equal(counted.strataRows, 4);
  assert.equal(agreementPasses(counted), false, "4 stratum rows nobody compared");

  const rows = STANDARD_ROWS.map((r) => (r.key === "PopulationSet_1_Stratification_1" ? { ...r, values: { ...r.values, NUMER: 0 } } : r));
  const report = await agreement(rows, STANDARD_ANSWERS);
  assert.deepEqual(report.disagreements.map((d) => [d.set, d.stratum, d.diffs]), [[0, 0, ["NUMER 0→1"]]]);
  assert.equal(agreementPasses(report), false);
});

test("engine errors fail the run: the batch is retried one patient at a time and the failures counted", async () => {
  const calls: number[] = [];
  const throwing: AgreementCalculate = async (input) => {
    calls.push(input.patientBundles.length);
    if (input.patientBundles.length > 1 || patientIdOf(input.patientBundles[0]) === "p2") throw new Error("Failed to locate element\nsecond line\nthird\nfourth");
    return stubCalculate(STANDARD_ANSWERS)(input);
  };
  const report = await agreement(STANDARD_ROWS, STANDARD_ANSWERS, "compare", throwing);
  assert.deepEqual(calls, [2, 1, 1]);
  assert.deepEqual(report.engineErrors, [{ message: "Failed to locate element second line third", patients: 1 }]);
  assert.equal(report.noResult, 1);
  assert.equal(report.patientsAgreeing, 1);
  assert.equal(agreementPasses(report), false);
});

test("agreementPasses: each clause on its own fails a report that otherwise passes", async () => {
  const good = await agreement(STANDARD_ROWS, STANDARD_ANSWERS);
  assert.ok(agreementPasses(good));
  const variants: Array<[string, Partial<AgreementReport>]> = [
    ["no rate rows at all", { sets: [] }],
    ["a rate with no rows", { sets: [{ ...good.sets[0]!, agree: 0, total: 0 }] }],
    ["a stratum short of its total", { strata: [{ ...good.strata[0]!, agree: 0 }] }],
    ["strata counted, not compared", { strataMode: "count", strata: [] }],
    ["an engine error", { engineErrors: [{ message: "x", patients: 1 }] }],
    ["an import failure", { importFailures: [{ patientId: "p9", reason: "missing" }] }],
    ["an unrecognised row", { unrecognisedRows: 1 }],
  ];
  for (const [label, change] of variants) assert.equal(agreementPasses({ ...good, ...change }), false, label);
});

test("a patient with no file is an import failure, and the render names patients only when asked", async () => {
  const deck: CypressDeck = readCypressDeck(writeSyntheticDeck(STANDARD_ROWS), "cms137");
  deck.patientFiles.delete("p2");
  const patients = importDeckPatients(deck, importDeps);
  assert.deepEqual(patients.failures, [{ patientId: "p2", reason: "missing" }]);
  const report = await runAgreement({ deck, patients, artifact: official, valueSetCache: [], trustMetaProfile: false, calculate: stubCalculate(STANDARD_ANSWERS), strata: "compare" });
  assert.equal(agreementPasses(report), false);

  const flipped = await agreement(
    STANDARD_ROWS.map((r) => (r.patient === "p1" && r.key === "PopulationSet_1" ? { ...r, values: { IPP: 0 } } : r)),
    STANDARD_ANSWERS,
  );
  const named = renderAgreementMarkdown(flipped, { artifact: "a", engine: "e" });
  const anonymous = renderAgreementMarkdown(flipped, { artifact: "a", engine: "e", namePatients: false });
  assert.match(named, /Alpha_Synthetic\.xml/, "the diagnostic harness names the file");
  assert.doesNotMatch(anonymous, /Alpha|Synthetic/, "a shareable render never names a patient");
  assert.match(anonymous, /patient p1/);
  assert.match(anonymous, /\| 1 \| 1 \| 1\/1 \|/, "the strata table is rendered");
  assert.match(anonymous, /strata rows compared: 4/);
});

test("the harness refuses --valuesets-dir for a translation, and runs the translation as itself", async () => {
  assert.throws(
    () => parseAgreementArgs(["--bundle-dir", "d", "--measure", "cms137", "--artifact", "derived", "--valuesets-dir", "v"]),
    (error: unknown) => error instanceof AgreementUsageError && /own terminology sidecar/.test(error.message),
  );
  assert.throws(() => parseAgreementArgs(["--bundle-dir", "d", "--measure", "cms137", "--strata", "sometimes"]), AgreementUsageError);
  assert.throws(() => parseAgreementArgs(["--bundle-dir", "d", "--measure", "cms137", "--artifact", "draft"]), AgreementUsageError);
  assert.deepEqual(parseAgreementArgs(["--bundle-dir", "d", "--measure", "cms137"]), {
    bundleDir: "d",
    measure: "cms137",
    artifact: "official",
    strata: "compare",
    limit: 40,
  });

  const dir = writeSyntheticDeck(STANDARD_ROWS);
  const seen: Array<{ measureUrl: unknown; patients: number }> = [];
  const printed: string[] = [];
  const derived = derivedCms137();
  const code = await agreementCli(["--bundle-dir", dir, "--measure", "cms137", "--artifact", "derived"], {
    calculate: stubCalculate(STANDARD_ANSWERS, seen),
    loadDerived: () => derived,
    loadOfficial: () => assert.fail("derived mode must not load CMS's artifact"),
    expand: async (oid, artifact) => (artifact === derived ? [{ system: "s", code: oid }] : []),
    importDeps,
    log: (text) => printed.push(text),
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [{ measureUrl: FIXTURE_URL, patients: 2 }], "the translation's Measure, not CMS's");
  assert.match(printed.join("\n"), /WorkWell translation .*terminology: the translation's own sidecar/);
  await assert.rejects(
    agreementCli(["--bundle-dir", dir, "--measure", "cms137", "--artifact", "derived", "--valuesets-dir", dir], { calculate: stubCalculate(STANDARD_ANSWERS) }),
    AgreementUsageError,
  );
  await assert.rejects(
    agreementCli(["--bundle-dir", dir, "--measure", "cms137", "--artifact", "derived"], { calculate: stubCalculate(STANDARD_ANSWERS), loadDerived: () => null, importDeps }),
    /no WorkWell translation is committed/,
  );
});

test("the harness exits 2 on engine errors and 0 otherwise", async () => {
  const dir = writeSyntheticDeck(STANDARD_ROWS);
  const failing: AgreementCalculate = async () => {
    throw new Error("boom");
  };
  const deps = { expand: async (oid: string) => [{ system: "s", code: oid }], importDeps, log: () => {} };
  assert.equal(await agreementCli(["--bundle-dir", dir, "--measure", "cms137"], { ...deps, calculate: failing }), 2);
  assert.equal(await agreementCli(["--bundle-dir", dir, "--measure", "cms137"], { ...deps, calculate: stubCalculate(STANDARD_ANSWERS) }), 0);
});
