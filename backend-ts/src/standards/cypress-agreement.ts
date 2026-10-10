/**
 * Per-patient agreement between a FHIR measure artifact and a Cypress bundle's own expected results.
 *
 * A Cypress measure bundle carries, for every test patient and measure, Cypress's precalculated
 * populations (`calculations/individual-results/*.json`) next to the patient as a QRDA Category I
 * (`patients/*.xml`). This module imports each patient through `qrda1-import.ts`, runs an artifact over
 * them with the bundle's own measurement period, and compares every population of every rate, and every
 * stratum, patient by patient.
 *
 * Two callers: `scripts/cvu/bundle-agreement.ts` (the diagnostic harness, `agreementCli` below) and
 * `derived:check` (`run/cli/derived-check.ts`), which records a passing run as a WorkWell translation's
 * `cypress-deck` oracle. One comparison for both, so the number the harness prints and the number a
 * manifest records cannot mean different things.
 *
 * fqm-execution is never imported here: the caller hands in `calculate` (the harness passes the
 * package's `calculateOfficialWithSignal`, `derived:check` the worker thread), so this module stays out
 * of the executor package's import allowlist (`fqm-isolation.test.ts`).
 *
 * Bundles and value sets are licensed (UMLS): nothing here writes, and nothing a caller may record holds
 * more than counts and hashes. Descriptive only — it authors no compliance status.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { importQrda1Document } from "../fhir/qrda1-import.ts";
import {
  artifactKind,
  loadDerivedArtifact,
  loadOfficialArtifact,
  type ArtifactKind,
  type OfficialArtifact,
} from "../wiring/official-artifacts.ts";
import { expandArtifactTerminology, type ExpandValueSet } from "../wiring/official-executor-adapter.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { officialTerminologyExpander } from "../wiring/official-terminology.ts";
import { preparedForQiCore, type PreparableBundle } from "../wiring/qicore-preparation.ts";

/** Cypress population keys → fqm population types. */
export const CYPRESS_POPULATIONS: ReadonlyArray<readonly [cypress: string, fqm: string]> = [
  ["IPP", "initial-population"],
  ["DENOM", "denominator"],
  ["DENEX", "denominator-exclusion"],
  ["DENEXCEP", "denominator-exception"],
  ["NUMER", "numerator"],
  ["NUMEX", "numerator-exclusion"],
];

export type StrataMode = "compare" | "count";

/** One expected row: a patient's populations for one rate. */
export interface DeckRow {
  patientId: string;
  /** 0-based rate index. Cypress's `PopulationSet_N` is the measure's Nth group. */
  set: number;
  values: Record<string, number>;
}

/** A `PopulationSet_N_Stratification_M` row: the patient is in stratum M of rate N. */
export interface DeckStratumRow extends DeckRow {
  /** 0-based stratifier index within the rate. */
  stratum: number;
}

export interface CypressDeck {
  dir: string;
  catalogId: string;
  meta: { version: string; title: string; release?: string };
  /** From `bundle.json`, never from the artifact: fqm takes the period from the call. */
  period: { start: string; end: string };
  /** The bundle's own measure for the catalog id, e.g. `CMS137v15`. */
  measure: { bundleId: string; name: string };
  sets: DeckRow[];
  strata: DeckStratumRow[];
  /** Rows for this measure keyed neither `PopulationSet_N` nor `PopulationSet_N_Stratification_M`. */
  unrecognisedRows: number;
  /** Every patient any row names, in first-seen order. */
  patientIds: string[];
  /** Patient id → its QRDA file name under `patients/` (every mapped patient, not only this measure's). */
  patientFiles: Map<string, string>;
  /**
   * What the deck's answer for THIS measure is made of: its `measure-id-mapping.csv` row, every
   * `individual-results` file for its measure id, and every patient file those rows reference, sorted by
   * name, hashed as `"<name>\n" + bytes` each. Not `bundle.json`: that is metadata, and a deck with a
   * changed patient or expected value must not keep the hash a recorded oracle names.
   */
  inputSha256: string;
}

const csvRows = (text: string): string[] => text.split(/\r?\n/).filter(Boolean);

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * The value-set release a deck names, as the release string the deck's own `value-set-codes.csv` uses:
 * `eCQM Update 2026-05-14`. Read from an explicit release string if the metadata carries one, else from
 * the title's "value sets as of May 14, 2026". Undefined when it names neither — the caller must then
 * be told the release, never guess one.
 */
export function deckValueSetRelease(meta: Record<string, unknown>): string | undefined {
  for (const value of Object.values(meta)) {
    if (typeof value !== "string" || value.length > 500) continue;
    const explicit = /eCQM Update \d{4}-\d{2}-\d{2}/.exec(value);
    if (explicit) return explicit[0];
  }
  const title = typeof meta["title"] === "string" ? meta["title"] : "";
  const asOf = /value sets as of ([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(title);
  if (!asOf) return undefined;
  const month = MONTHS.indexOf(asOf[1]!.toLowerCase());
  if (month < 0) return undefined;
  return `eCQM Update ${asOf[3]}-${String(month + 1).padStart(2, "0")}-${asOf[2]!.padStart(2, "0")}`;
}

/** Read a Cypress bundle's expected results for one catalog measure. Throws when the deck cannot answer. */
export function readCypressDeck(bundleDir: string, catalogId: string): CypressDeck {
  if (!/^cms\d+$/i.test(catalogId)) throw new Error(`a catalog id such as cms125 is required, not ${JSON.stringify(catalogId)}`);
  const meta = JSON.parse(readFileSync(path.join(bundleDir, "bundle.json"), "utf8")) as Record<string, unknown> & {
    version: string;
    title: string;
    measure_period_start: number;
    effective_date: number;
  };
  const day = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
  const period = { start: day(meta.measure_period_start), end: day(meta.effective_date) };

  // The bundle's measure for our id, e.g. cms125 → CMS125v15. `CMS125` + `v` + digits, matched as text:
  // no pattern is built from the command line.
  const mappingLines = csvRows(readFileSync(path.join(bundleDir, "calculations", "measure-id-mapping.csv"), "utf8"));
  const prefix = `${catalogId.toUpperCase()}v`;
  const wanted = mappingLines.filter((line) => {
    const cms = line.split(",")[1];
    return typeof cms === "string" && cms.startsWith(prefix) && /^\d+$/.test(cms.slice(prefix.length));
  });
  if (wanted.length !== 1) {
    throw new Error(`${catalogId}: expected one bundle measure, found ${wanted.map((line) => line.split(",")[1]).join(", ") || "none"}`);
  }
  const mappingRow = wanted[0]!;
  const [bundleId, name] = mappingRow.split(",") as [string, string];

  // Patient id → its QRDA file. Files are named `<given>_<family>.xml` with spaces as underscores.
  const patientFiles = new Map(
    csvRows(readFileSync(path.join(bundleDir, "calculations", "patient-id-mapping.csv"), "utf8")).map((line) => {
      const [id, given, family] = line.split(",");
      return [id!, `${given}_${family}`.replace(/\s+/g, "_") + ".xml"] as const;
    }),
  );

  const hashed: Array<{ name: string; bytes: Buffer | string }> = [{ name: "calculations/measure-id-mapping.csv", bytes: mappingRow }];
  const sets: DeckRow[] = [];
  const strata: DeckStratumRow[] = [];
  let unrecognisedRows = 0;
  const resultsDir = path.join(bundleDir, "calculations", "individual-results");
  for (const file of readdirSync(resultsDir).sort()) {
    const bytes = readFileSync(path.join(resultsDir, file));
    const r = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (r["measure_id"] !== bundleId) continue;
    hashed.push({ name: `calculations/individual-results/${file}`, bytes });
    const values: Record<string, number> = {};
    for (const [cypress] of CYPRESS_POPULATIONS) values[cypress] = Number(r[cypress] ?? 0);
    const key = String(r["population_set_key"] ?? "");
    const patientId = String(r["patient_id"]);
    const set = /^PopulationSet_(\d+)$/.exec(key);
    const stratum = /^PopulationSet_(\d+)_Stratification_(\d+)$/.exec(key);
    if (set) sets.push({ patientId, set: Number(set[1]) - 1, values });
    else if (stratum) strata.push({ patientId, set: Number(stratum[1]) - 1, stratum: Number(stratum[2]) - 1, values });
    else unrecognisedRows++;
  }
  const patientIds = [...new Set([...sets, ...strata].map((row) => row.patientId))];
  for (const id of patientIds) {
    const file = patientFiles.get(id);
    const full = file ? path.join(bundleDir, "patients", file) : "";
    if (file && existsSync(full)) hashed.push({ name: `patients/${file}`, bytes: readFileSync(full) });
  }
  hashed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash("sha256");
  for (const { name: entry, bytes } of hashed) {
    hash.update(`${entry}\n`);
    hash.update(bytes);
  }

  const release = deckValueSetRelease(meta);
  return {
    dir: bundleDir,
    catalogId,
    meta: { version: String(meta.version), title: String(meta.title), ...(release ? { release } : {}) },
    period,
    measure: { bundleId, name },
    sets,
    strata,
    unrecognisedRows,
    patientIds,
    patientFiles,
    inputSha256: `sha256:${hash.digest("hex")}`,
  };
}

export interface ImportFailure {
  patientId: string;
  file?: string;
  /** `missing`: no file is mapped or present; `import`: the importer refused it. */
  reason: "missing" | "import";
  message?: string;
}

export interface ImportedDeckPatients {
  bundles: unknown[];
  importedIds: Set<string>;
  failures: ImportFailure[];
  /** QDM template → how many patients carried it untranslated. */
  untranslated: Map<string, number>;
}

export interface ImportDeckDeps {
  importDocument?: (xml: string) => { bundle: unknown; untranslatedTemplates: readonly string[] };
  prepare?: (bundle: unknown) => unknown;
  readFile?: (file: string) => string;
}

/** Import each referenced patient once, keyed by the bundle's patient id so fqm's results key back. */
export function importDeckPatients(deck: CypressDeck, deps: ImportDeckDeps = {}): ImportedDeckPatients {
  const importDocument = deps.importDocument ?? importQrda1Document;
  const prepare = deps.prepare ?? ((bundle: unknown) => preparedForQiCore(bundle as PreparableBundle));
  const read = deps.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const out: ImportedDeckPatients = { bundles: [], importedIds: new Set(), failures: [], untranslated: new Map() };
  for (const id of deck.patientIds) {
    const file = deck.patientFiles.get(id);
    const full = file ? path.join(deck.dir, "patients", file) : "";
    if (!file || !existsSync(full)) {
      out.failures.push({ patientId: id, ...(file ? { file } : {}), reason: "missing" });
      continue;
    }
    try {
      const imported = importDocument(read(full));
      for (const t of imported.untranslatedTemplates) out.untranslated.set(t, (out.untranslated.get(t) ?? 0) + 1);
      const b = imported.bundle as { entry: Array<{ resource: Record<string, unknown> }> };
      const patient = b.entry.find((e) => e.resource["resourceType"] === "Patient");
      if (patient) patient.resource["id"] = id; // key fqm's result by the bundle's patient id
      out.bundles.push(prepare(b));
      out.importedIds.add(id);
    } catch (error) {
      out.failures.push({ patientId: id, file, reason: "import", message: String((error as Error)?.message ?? error) });
    }
  }
  return out;
}

/** What a run needs back per subject: every rate's populations and every rate's stratifier results. */
export interface AgreementSubjectResult {
  rates: ReadonlyArray<ReadonlyArray<{ populationType: string; result: boolean }>>;
  strata: ReadonlyArray<ReadonlyArray<{ result?: boolean; strataId?: string; strataCode?: string }>>;
}

/**
 * The calculation, injected: structurally `calculateOfficialWithSignal` and the worker's `calculate`.
 * One patient that throws rejects the whole batch, which `runAgreement` handles by retrying one by one.
 */
export type AgreementCalculate = (input: {
  bundle: OfficialArtifact["bundle"];
  patientBundles: unknown[];
  period: { start: string; end: string };
  valueSetCache: unknown[];
  options: { trustMetaProfile: boolean; trustedProfiles?: readonly string[] };
}) => Promise<{ bySubject: ReadonlyMap<string, AgreementSubjectResult> }>;

export interface AgreementTally {
  agree: number;
  total: number;
  /** Patients Cypress puts in each population (every expected row counts, answered or not). */
  expected: Record<string, number>;
  /** Patients the artifact put there; for a stratum, only those it also placed in that stratum. */
  reported: Record<string, number>;
}

export interface AgreementDisagreement {
  set: number;
  stratum?: number;
  patientId: string;
  file?: string;
  diffs: string[];
}

export interface AgreementReport {
  catalogId: string;
  deckMeasure: string;
  deckVersion: string;
  deckTitle: string;
  period: { start: string; end: string };
  artifact: { kind: ArtifactKind; url: string; sha256: string };
  trustMetaProfile: boolean;
  /** Profiles retrieved by `meta.profile` while every other retrieve is by type (#591); empty when none. */
  trustedProfiles: readonly string[];
  strataMode: StrataMode;
  patients: number;
  /** Patients whose every compared row (each rate, and each stratum when compared) agreed. */
  patientsAgreeing: number;
  importFailures: ImportFailure[];
  /** Imported patients the engine returned nothing for. */
  noResult: number;
  engineErrors: Array<{ message: string; patients: number }>;
  sets: Array<AgreementTally & { set: number }>;
  /** Empty in `count` mode. */
  strata: Array<AgreementTally & { set: number; stratum: number }>;
  strataRows: number;
  unrecognisedRows: number;
  /** The first `limit` disagreements; `disagreementCount` is all of them. */
  disagreements: AgreementDisagreement[];
  disagreementCount: number;
  untranslated: Array<[template: string, patients: number]>;
}

export interface RunAgreementInput {
  deck: CypressDeck;
  patients: ImportedDeckPatients;
  artifact: OfficialArtifact;
  valueSetCache: unknown[];
  trustMetaProfile: boolean;
  /** As the executor's option: by type except these profiles. Ignored when `trustMetaProfile` is on. */
  trustedProfiles?: readonly string[];
  calculate: AgreementCalculate;
  strata: StrataMode;
  limit?: number;
}

const measureUrlOf = (artifact: OfficialArtifact): string =>
  String((artifact.bundle.entry ?? []).map((e) => e.resource).find((r) => r?.["resourceType"] === "Measure")?.["url"] ?? "");

const newTally = (): AgreementTally => ({ agree: 0, total: 0, expected: {}, reported: {} });

/** Run the artifact over the deck's patients and compare every expected row. */
export async function runAgreement(input: RunAgreementInput): Promise<AgreementReport> {
  const { deck, patients, artifact, valueSetCache, trustMetaProfile, calculate } = input;
  const trustedProfiles = trustMetaProfile ? [] : (input.trustedProfiles ?? []);
  const limit = input.limit ?? 40;
  const options = { trustMetaProfile, ...(trustedProfiles.length > 0 ? { trustedProfiles } : {}) };
  const run = async (patientBundles: unknown[]) =>
    (await calculate({ bundle: artifact.bundle, patientBundles, period: deck.period, valueSetCache, options })).bySubject;

  const bySubject = new Map<string, AgreementSubjectResult>();
  const engineErrors = new Map<string, number>(); // first lines of the message -> patients
  try {
    for (const [id, result] of await run(patients.bundles)) bySubject.set(id, result);
  } catch {
    // One patient that throws rejects fqm's whole batch. The QRDA I route evaluates each subject on its own
    // and records a failure for that subject only, so retry one patient at a time and do the same.
    for (const one of patients.bundles) {
      try {
        for (const [id, result] of await run([one])) bySubject.set(id, result);
      } catch (error) {
        const line = String((error as Error)?.message ?? error).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ");
        engineErrors.set(line, (engineErrors.get(line) ?? 0) + 1);
      }
    }
  }

  const disagreements: AgreementDisagreement[] = [];
  let disagreementCount = 0;
  const disagreeing = new Set<string>();
  const disagree = (d: AgreementDisagreement) => {
    disagreeing.add(d.patientId);
    disagreementCount++;
    if (disagreements.length < limit) disagreements.push(d);
  };
  const fileOf = (id: string) => deck.patientFiles.get(id);
  const populationsOf = (result: AgreementSubjectResult, set: number): Record<string, number> => {
    const rate = result.rates[set] ?? [];
    const got: Record<string, number> = {};
    for (const [cypress, fqm] of CYPRESS_POPULATIONS) got[cypress] = rate.some((p) => p.populationType === fqm && p.result) ? 1 : 0;
    return got;
  };
  const populationDiffs = (values: Record<string, number>, got: Record<string, number>): string[] =>
    CYPRESS_POPULATIONS.filter(([c]) => (values[c] ? 1 : 0) !== got[c]).map(([c]) => `${c} ${values[c] ? 1 : 0}→${got[c]}`);

  // Rates are matched by position: Cypress's `PopulationSet_N` is the measure's Nth group, which is also
  // the order fqm returns them in for every measure here.
  const bySet = new Map<number, AgreementTally>();
  for (const e of deck.sets) {
    const tally = bySet.get(e.set) ?? newTally();
    bySet.set(e.set, tally);
    tally.total++;
    // Expected counts include every patient, so a missing engine result shows as a shortfall in the
    // reported column instead of shrinking both.
    for (const [c] of CYPRESS_POPULATIONS) tally.expected[c] = (tally.expected[c] ?? 0) + (e.values[c] ? 1 : 0);
    const result = bySubject.get(e.patientId);
    if (!result) {
      for (const [c] of CYPRESS_POPULATIONS) tally.reported[c] = tally.reported[c] ?? 0;
      disagreeing.add(e.patientId);
      continue;
    }
    const got = populationsOf(result, e.set);
    for (const [c] of CYPRESS_POPULATIONS) tally.reported[c] = (tally.reported[c] ?? 0) + got[c]!;
    const diffs = populationDiffs(e.values, got);
    if (diffs.length === 0) tally.agree++;
    else disagree({ set: e.set, patientId: e.patientId, file: fileOf(e.patientId), diffs });
  }

  // A stratum row says the patient is in stratum M of rate N, with rate N's populations. Agreement is
  // both halves: the artifact places the patient in stratum M and in no other stratum of that rate (by
  // `result`, the stratum membership — not `appliesResult`, which also folds in a population), and its
  // rate-N populations equal the row's.
  const byStratum = new Map<string, AgreementTally & { set: number; stratum: number }>();
  if (input.strata === "compare") {
    for (const e of deck.strata) {
      const key = `${e.set}:${e.stratum}`;
      const tally = byStratum.get(key) ?? { ...newTally(), set: e.set, stratum: e.stratum };
      byStratum.set(key, tally);
      tally.total++;
      for (const [c] of CYPRESS_POPULATIONS) tally.expected[c] = (tally.expected[c] ?? 0) + (e.values[c] ? 1 : 0);
      const result = bySubject.get(e.patientId);
      if (!result) {
        for (const [c] of CYPRESS_POPULATIONS) tally.reported[c] = tally.reported[c] ?? 0;
        disagreeing.add(e.patientId);
        continue;
      }
      const got = populationsOf(result, e.set);
      const reportedStrata = result.strata[e.set] ?? [];
      const inStratum = reportedStrata[e.stratum]?.result === true;
      for (const [c] of CYPRESS_POPULATIONS) tally.reported[c] = (tally.reported[c] ?? 0) + (inStratum ? got[c]! : 0);
      const diffs = populationDiffs(e.values, got);
      if (reportedStrata.length <= e.stratum) diffs.push(`stratum ${e.stratum + 1} not reported (${reportedStrata.length} reported)`);
      reportedStrata.forEach((s, m) => {
        const want = m === e.stratum;
        if ((s?.result === true) !== want) diffs.push(`stratum ${m + 1} ${want ? 1 : 0}→${want ? 0 : 1}`);
      });
      if (diffs.length === 0) tally.agree++;
      else disagree({ set: e.set, stratum: e.stratum, patientId: e.patientId, file: fileOf(e.patientId), diffs });
    }
  }

  return {
    catalogId: deck.catalogId,
    deckMeasure: deck.measure.name,
    deckVersion: deck.meta.version,
    deckTitle: deck.meta.title,
    period: deck.period,
    artifact: { kind: artifactKind(artifact), url: measureUrlOf(artifact), sha256: artifact.manifest.sha256 },
    trustMetaProfile,
    trustedProfiles,
    strataMode: input.strata,
    patients: deck.patientIds.length,
    patientsAgreeing: deck.patientIds.filter((id) => !disagreeing.has(id)).length,
    importFailures: patients.failures,
    // Per patient, not per rate: a patient missing from a two-rate measure is one patient.
    noResult: [...patients.importedIds].filter((id) => !bySubject.has(id)).length,
    engineErrors: [...engineErrors].map(([message, n]) => ({ message, patients: n })),
    sets: [...bySet.entries()].sort((a, b) => a[0] - b[0]).map(([set, t]) => ({ set, ...t })),
    strata: [...byStratum.values()].sort((a, b) => a.set - b.set || a.stratum - b.stratum),
    strataRows: deck.strata.length,
    unrecognisedRows: deck.unrecognisedRows,
    disagreements,
    disagreementCount,
    untranslated: [...patients.untranslated.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/**
 * Whether a run is evidence: every rate and every stratum agreed on every row (and there were rows), the
 * engine raised nothing, every patient imported, and nothing in the deck went uncompared — a stratum
 * row counted but not compared, or a row of an unrecognised shape, is a part of the answer key nobody
 * checked.
 */
export function agreementPasses(report: AgreementReport): boolean {
  const full = (t: AgreementTally) => t.total > 0 && t.agree === t.total;
  if (report.sets.length === 0 || !report.sets.every(full)) return false;
  if (report.strataRows > 0 && (report.strataMode !== "compare" || !report.strata.every(full))) return false;
  // Implied by the row tallies today (a patient the engine or the importer failed has rows that cannot
  // agree), and kept anyway: they are what the predicate promises, and they hold if a tally ever changes.
  return report.engineErrors.length === 0 && report.importFailures.length === 0 && report.unrecognisedRows === 0;
}

/** Rows agreeing across every compared rate and stratum — what a deliberately broken artifact must lower. */
export const rowsAgreeing = (report: AgreementReport): number =>
  [...report.sets, ...report.strata].reduce((n, t) => n + t.agree, 0);

export interface RenderAgreementOptions {
  /** The `- artifact:` line, e.g. "vendored official cms137; terminology: vendored sidecar". */
  artifact: string;
  /** Indented lines under it. */
  artifactNotes?: string[];
  engine: string;
  /**
   * Name patients by their QRDA file (default, the diagnostic harness) or by Cypress id only — the
   * files are named after the patient, so anything that may be pasted or shared uses `false`.
   */
  namePatients?: boolean;
  limit?: number;
}

export function renderAgreementMarkdown(report: AgreementReport, options: RenderAgreementOptions): string {
  const named = options.namePatients ?? true;
  const who = (patientId: string, file?: string) => (named ? `\`${file}\`` : `patient ${patientId}`);
  const header = CYPRESS_POPULATIONS.map(([c]) => c);
  const out: string[] = [
    `# Agreement: ${report.catalogId} vs ${report.deckMeasure} (${report.deckVersion})`,
    "",
    `- bundle: ${report.deckTitle}`,
    `- measurement period: ${report.period.start} … ${report.period.end}`,
    `- artifact: ${options.artifact}`,
    ...(options.artifactNotes ?? []).map((note) => `  - ${note}`),
    `- engine: ${options.engine}`,
  ];
  const notImported = `${report.patients} (${report.importFailures.length} not imported, ${report.noResult} imported with no engine result)`;
  out.push(
    report.strataMode === "compare"
      ? `- patients: ${notImported}; strata rows compared: ${report.strataRows}; patients agreeing on every row: ${report.patientsAgreeing}/${report.patients}`
      : `- patients: ${notImported}; strata rows not compared: ${report.strataRows}`,
  );
  if (report.unrecognisedRows) out.push(`- rows of an unrecognised population_set_key, not compared: ${report.unrecognisedRows}`);
  if (report.engineErrors.length) {
    out.push("", "## Engine errors", "");
    for (const { message, patients } of report.engineErrors) out.push(`- ${patients} patient(s): ${message}`);
  }
  out.push("", `| set | patients agreeing | ${header.join(" | ")} |`, `|---|---|${header.map(() => "---|").join("")}`);
  const cells = (t: AgreementTally) => CYPRESS_POPULATIONS.map(([c]) => `${t.expected[c]} / ${t.reported[c]}`).join(" | ");
  for (const t of report.sets) out.push(`| ${t.set + 1} | ${t.agree}/${t.total} | ${cells(t)} |`);
  if (report.strata.length) {
    out.push("", `| set | stratum | rows agreeing | ${header.join(" | ")} |`, `|---|---|---|${header.map(() => "---|").join("")}`);
    for (const t of report.strata) out.push(`| ${t.set + 1} | ${t.stratum + 1} | ${t.agree}/${t.total} | ${cells(t)} |`);
  }
  out.push("", "Cells are expected (Cypress) / reported (WorkWell).");
  if (report.disagreements.length) {
    out.push("", `## Disagreements (first ${options.limit ?? report.disagreements.length})`, "");
    for (const d of report.disagreements) {
      const where = d.stratum === undefined ? `set ${d.set + 1}` : `set ${d.set + 1} stratum ${d.stratum + 1}`;
      out.push(`- ${where} ${who(d.patientId, d.file)}: ${d.diffs.join(", ")}`);
    }
  }
  if (report.untranslated.length) {
    out.push("", "## Untranslated QDM templates", "");
    for (const [t, n] of report.untranslated) out.push(`- \`${t}\` × ${n}`);
  }
  if (report.importFailures.length) {
    out.push("", "## Import failures", "");
    for (const f of report.importFailures.slice(0, 20)) {
      if (!named) out.push(`- ${f.patientId}: ${f.reason === "missing" ? "no patient file" : "import refused"}`);
      else if (f.reason === "missing") out.push(`- ${f.patientId}: no patient file (${f.file ?? "unmapped"})`);
      else out.push(`- ${f.patientId} (${f.file}): ${f.message}`);
    }
  }
  return out.join("\n");
}

// ---- the diagnostic harness's command line (`scripts/cvu/bundle-agreement.ts`) ------------------------

export class AgreementUsageError extends Error {
  override readonly name = "AgreementUsageError";
}

export const AGREEMENT_USAGE =
  "usage: --bundle-dir <extracted bundle> --measure <cms id> [--artifact official|derived] [--strata compare|count] " +
  "[--valuesets-dir <dir>] [--trust-meta-profile on|off] [--limit 40]";

export interface AgreementCliArgs {
  bundleDir: string;
  measure: string;
  artifact: ArtifactKind;
  strata: StrataMode;
  valuesetsDir?: string;
  trustMetaProfile?: boolean;
  limit: number;
}

export function parseAgreementArgs(argv: readonly string[]): AgreementCliArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bundleDir = get("--bundle-dir");
  const measure = get("--measure");
  if (!bundleDir || !measure) throw new AgreementUsageError(AGREEMENT_USAGE);
  if (!/^cms\d+$/i.test(measure)) throw new AgreementUsageError(`--measure takes a catalog id such as cms125, not ${JSON.stringify(measure)}`);
  const trust = get("--trust-meta-profile");
  if (trust !== undefined && trust !== "on" && trust !== "off") throw new AgreementUsageError("--trust-meta-profile takes on or off");
  const artifact = get("--artifact") ?? "official";
  if (artifact !== "official" && artifact !== "derived") throw new AgreementUsageError("--artifact takes official or derived");
  const strata = get("--strata") ?? "compare";
  if (strata !== "compare" && strata !== "count") throw new AgreementUsageError("--strata takes compare or count");
  const valuesetsDir = get("--valuesets-dir");
  // A translation is proven on its own terminology: swapping in on-disk expansions would score logic the
  // manifest never pinned against codes it never shipped.
  if (artifact === "derived" && valuesetsDir !== undefined) {
    throw new AgreementUsageError("--valuesets-dir cannot be used with --artifact derived: a translation runs on its own terminology sidecar");
  }
  return {
    bundleDir,
    measure,
    artifact,
    strata,
    ...(valuesetsDir !== undefined ? { valuesetsDir } : {}),
    ...(trust ? { trustMetaProfile: trust === "on" } : {}),
    limit: Number(get("--limit") ?? 40),
  };
}

export interface AgreementCliDeps {
  /** Required: this module never reaches fqm-execution itself (see the header). */
  calculate: AgreementCalculate;
  loadOfficial?: (catalogId: string) => OfficialArtifact | null;
  loadDerived?: (catalogId: string) => OfficialArtifact | null;
  expand?: ExpandValueSet;
  importDeps?: ImportDeckDeps;
  semantics?: (catalogId: string) => { trustedProfiles?: readonly string[] } | undefined;
  log?: (text: string) => void;
}

/**
 * The harness: prints the agreement as markdown and returns 2 when the engine raised errors, else 0.
 * Throws on a usage or loading problem (the script exits 1). Writes nothing.
 */
export async function agreementCli(argv: readonly string[], deps: AgreementCliDeps): Promise<number> {
  const args = parseAgreementArgs(argv);
  const deck = readCypressDeck(args.bundleDir, args.measure);
  const patients = importDeckPatients(deck, deps.importDeps);

  const artifact =
    args.artifact === "derived" ? (deps.loadDerived ?? loadDerivedArtifact)(args.measure) : (deps.loadOfficial ?? loadOfficialArtifact)(args.measure);
  if (!artifact) {
    throw new Error(
      args.artifact === "derived" ? `${args.measure}: no WorkWell translation is committed under measures/derived/` : `${args.measure}: no official artifact is vendored`,
    );
  }
  const vendored = (await expandArtifactTerminology(artifact, deps.expand ?? officialTerminologyExpander())) as Array<{ url?: string }>;
  // On-disk expansions replace the vendored ones by URL. A value set the artifact references but the
  // directory lacks (one the newer release retired or renamed) keeps its vendored expansion, and is listed.
  let valueSetCache: unknown[] = vendored;
  const fellBack: string[] = [];
  if (args.valuesetsDir) {
    const onDisk = readdirSync(args.valuesetsDir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .map((f) => JSON.parse(readFileSync(path.join(args.valuesetsDir!, f), "utf8")) as { url?: string });
    const urls = new Set(onDisk.map((vs) => vs.url));
    const kept = vendored.filter((vs) => !urls.has(vs.url));
    fellBack.push(...kept.map((vs) => String(vs.url)));
    valueSetCache = [...onDisk, ...kept];
  }

  const semantics = (deps.semantics ?? officialMeasureSemantics)(args.measure);
  // Production retrieves by type, except the measure's own trusted profiles (#591). The override is for
  // diagnosis: `on` trusts every profile, `off` none, and either drops the production list.
  const productionProfiles = semantics?.trustedProfiles ?? [];
  const trustMetaProfile = args.trustMetaProfile ?? false;
  const trustedProfiles = args.trustMetaProfile === undefined ? productionProfiles : [];
  const describe = (all: boolean, some: readonly string[]) =>
    all ? "every profile trusted" : some.length > 0 ? `by type, except ${some.map((p) => p.split("/").pop()).join(", ")}` : "by type";
  const engine =
    `retrieves ${describe(trustMetaProfile, trustedProfiles)}` +
    (!semantics
      ? " (production has no recorded semantics for this measure and refuses to run it)"
      : args.trustMetaProfile === undefined
        ? " (as production runs this measure)"
        : ` (OVERRIDDEN: production retrieves ${describe(false, productionProfiles)})`);

  const report = await runAgreement({
    deck,
    patients,
    artifact,
    valueSetCache,
    trustMetaProfile,
    trustedProfiles,
    calculate: deps.calculate,
    strata: args.strata,
    limit: args.limit,
  });
  const terminology = args.valuesetsDir
    ? `on disk (${args.valuesetsDir}), ${fellBack.length} value set(s) not on disk kept vendored`
    : args.artifact === "derived"
      ? "the translation's own sidecar"
      : "vendored sidecar";
  const described =
    args.artifact === "derived"
      ? `WorkWell translation ${artifact.manifest.derived?.label ?? args.measure} (${artifact.manifest.version}, ${artifact.manifest.sha256}); terminology: ${terminology}`
      : `vendored official ${args.measure}; terminology: ${terminology}`;
  (deps.log ?? console.log)(
    renderAgreementMarkdown(report, {
      artifact: described,
      artifactNotes: fellBack.map((url) => `vendored: \`${url}\``),
      engine,
      limit: args.limit,
    }),
  );
  return report.engineErrors.length ? 2 : 0;
}
