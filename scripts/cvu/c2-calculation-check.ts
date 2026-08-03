#!/usr/bin/env -S node --import tsx
/**
 * The Cypress **Calculation Check (C2)** comparison, run offline against a downloaded patient archive.
 *
 * C2 is §170.315(c)(2) "import and calculate": Cypress hands out its own generated patients as QRDA
 * Category I, the system under test imports and calculates them, and `ExpectedResultsValidator` compares
 * the submitted numbers against Cypress's precalculated `expected_results`. This script performs that
 * comparison **directly**, without the Cypress upload leg — so it measures the thing C2 grades (our
 * population counts) without first needing a run-finalize route and a QRDA III export.
 *
 *   pnpm --dir backend-ts exec tsx ../scripts/cvu/c2-calculation-check.ts \
 *     --docs cvu-workdir/c2/passA/CMS122v14 --measure cms122 \
 *     --expected cvu-workdir/c2/passA/snapshot.json --expected-key CMS122v14
 *
 * ## Three things it does that a naive loop over the documents would get wrong
 *
 * 1. **Documents are not people.** `ProductTest#archive_patients` splits one patient's clinical data
 *    across TWO documents (`ClinicalRandomizer`) and appends 1–3 demographically "augmented" duplicates
 *    (`sample_and_duplicate_patients`) — each with a fresh Cypress MRN. The expected results are computed
 *    over the ORIGINAL patients, so a receiver that treats every document as a subject reports more
 *    people than exist and fails C2 on arithmetic rather than on logic. Identity here is the Medicare
 *    Beneficiary Identifier where present (it survives both transforms), falling back to name+birth for
 *    the patients Cypress emits without one.
 * 2. **The measurement period is Cypress's, not ours.** `officialMeasurementPeriod` deliberately uses the
 *    registry's ROLLING window (ADR-039); Cypress computes its expected results over the bundle's own
 *    `measure_period_start … effective_date`. `--period-start/--period-end` take Cypress's, and
 *    `--also-rolling` re-runs the same subjects on the rolling window so the difference is MEASURED
 *    rather than assumed away.
 * 3. **A dropped datatype is a silent wrong answer.** Every untranslated QDM template is reported per
 *    measure, because an entry this importer cannot read is a population difference waiting to happen.
 *
 * Descriptive only: it writes nothing, persists nothing, and authors no compliance status. Like the rest
 * of `scripts/cvu/`, it is a reference-only path and is not wired into CI.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { importQrda1Document } from "../../backend-ts/src/fhir/qrda1-import.ts";
import { loadOfficialArtifact } from "../../backend-ts/src/wiring/official-artifacts.ts";
import { officialTerminologyExpander } from "../../backend-ts/src/wiring/official-terminology.ts";
import { expandArtifactTerminology, officialMeasurementPeriod } from "../../backend-ts/src/wiring/official-executor-adapter.ts";
import { preparedForQiCore, type PreparableBundle } from "../../backend-ts/src/wiring/qicore-preparation.ts";
// The package by PATH, not by workspace name: this file lives outside `backend-ts/`, so node resolves
// its bare specifiers against `scripts/`. It is still the package (the sole home of `fqm-execution`,
// PR-4/ADR-026) and not fqm itself — `fqm-isolation.test.ts` scans `src/` and `packages/`, and nothing
// here reaches around that boundary. It is imported directly rather than through the adapter because C2
// needs an EXPLICIT measurement period, which `officialMeasureExecutor` does not accept by design.
import {
  calculateOfficialWithSignal,
  type OfficialSubjectResult,
} from "../../backend-ts/packages/official-executor/src/index.ts";

/** Cypress's `expected_results` keys → the fqm population types they correspond to. */
const POPULATION_KEYS: ReadonlyArray<[cypress: string, fqm: string]> = [
  ["IPP", "initial-population"],
  ["DENOM", "denominator"],
  ["NUMER", "numerator"],
  ["DENEX", "denominator-exclusion"],
  ["DENEXCEP", "denominator-exception"],
  ["NUMEX", "numerator-exclusion"],
];

/** The two identifier roots a Cypress QRDA Category I carries in `<recordTarget>`. */
const MRN_ROOT = "1.3.6.1.4.1.115";
const MBI_ROOT = "2.16.840.1.113883.4.927";

interface Args {
  docs: string;
  measure: string;
  expected?: string;
  expectedKey?: string;
  periodStart: string;
  periodEnd: string;
  perPatient?: string;
  perPatientKey?: string;
  alsoRolling: boolean;
  byDocument: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Partial<Args> = { alsoRolling: false, byDocument: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--docs") args.docs = argv[++i];
    else if (arg === "--measure") args.measure = argv[++i];
    else if (arg === "--expected") args.expected = argv[++i];
    else if (arg === "--expected-key") args.expectedKey = argv[++i];
    else if (arg === "--per-patient") args.perPatient = argv[++i];
    else if (arg === "--per-patient-key") args.perPatientKey = argv[++i];
    else if (arg === "--period-start") args.periodStart = argv[++i];
    else if (arg === "--period-end") args.periodEnd = argv[++i];
    else if (arg === "--also-rolling") args.alsoRolling = true;
    else if (arg === "--by-document") args.byDocument = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.docs) throw new Error("--docs <directory of QRDA Category I xml> is required");
  if (!args.measure) throw new Error("--measure <catalog id, e.g. cms122> is required");
  if (!args.periodStart || !args.periodEnd) {
    throw new Error(
      "--period-start and --period-end are required. Take them from the Cypress bundle " +
        "(`measure_period_start` / `effective_date`) — guessing the measurement period is how a correct " +
        "engine gets reported as wrong.",
    );
  }
  return args as Args;
}

/**
 * The identity a receiver must resolve to, across the documents Cypress deliberately multiplies.
 *
 * The MBI is the only identifier that survives both archive transforms: a clinical split and an
 * augmented duplicate each get a NEW Cypress MRN, and the augmented one also gets a randomized first
 * name, last name OR birthdate — never all three. Where Cypress emits no MBI at all (measured: the four
 * `*_Virtual` patients in the 2025 bundle's CMS122 test), name+birth separates them, which is sound
 * there precisely because those patients are never the ones duplicated.
 */
export function identityKey(xml: string): { key: string; mbi: string | null; mrn: string | null; label: string } {
  const rt = /<recordTarget>[\s\S]*?<\/recordTarget>/.exec(xml)?.[0] ?? "";
  const ids = [...rt.matchAll(/<id\s+extension=["']([^"']+)["']\s+root=["']([^"']+)["']/g)];
  const mbi = ids.find((m) => m[2] === MBI_ROOT)?.[1] ?? null;
  const mrn = ids.find((m) => m[2] === MRN_ROOT)?.[1] ?? null;
  const given = [...rt.matchAll(/<given>([^<]*)<\/given>/g)].map((m) => m[1]).join(" ");
  const family = /<family>([^<]*)<\/family>/.exec(rt)?.[1] ?? "";
  const birth = /<birthTime[^>]*value=["']([^"']+)["']/.exec(rt)?.[1] ?? "";
  const label = `${given} ${family}`.trim();
  return { key: mbi ? `mbi:${mbi}` : `dem:${label}|${birth}`, mbi, mrn, label };
}

interface Person {
  key: string;
  label: string;
  documents: string[];
  bundle: { resourceType: "Bundle"; type: "collection"; entry: Array<{ resource: unknown }> };
}

/**
 * Merge every document belonging to one person into a single bundle.
 *
 * The importer emits no subject references (resources stand alone in a per-patient bundle), so a merge
 * is a union of clinical resources under the FIRST document's Patient. Resource ids are namespaced by
 * document index: two documents for the same person can legitimately carry the same generated id, and a
 * collision would silently drop half a split patient's data — the exact failure this merge exists to
 * prevent.
 */
export function mergeDocuments(
  docs: ReadonlyArray<{ file: string; bundle: { entry?: Array<{ resource: unknown }> } }>,
  key: string,
  label: string,
): Person {
  const entries: Array<{ resource: unknown }> = [];
  let patientSeen = false;
  docs.forEach((doc, index) => {
    for (const entry of doc.bundle.entry ?? []) {
      const resource = entry.resource as { resourceType?: string; id?: string };
      if (resource?.resourceType === "Patient") {
        if (patientSeen) continue;
        patientSeen = true;
        entries.unshift({ resource: { ...resource, id: sanitizeId(key) } });
        continue;
      }
      entries.push({ resource: { ...resource, id: `${index}-${resource?.id ?? entries.length}` } });
    }
  });
  return { key, label, documents: docs.map((d) => d.file), bundle: { resourceType: "Bundle", type: "collection", entry: entries } };
}

/** FHIR `id` is `[A-Za-z0-9-.]{1,64}` — an MBI is alphanumeric, but the `mbi:`/`dem:` prefixes are not. */
function sanitizeId(key: string): string {
  return key.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 64);
}

/** The id fqm will key this subject's result by — read from the bundle rather than recomputed. */
function patientIdOf(bundle: Person["bundle"]): string {
  const patient = bundle.entry.find((e) => (e.resource as { resourceType?: string })?.resourceType === "Patient");
  return ((patient?.resource as { id?: string })?.id ?? "") as string;
}

// `bySubject` yields an `OfficialSubjectResult`, whose `populations` is the code→boolean map. Reading
// the wrapper directly is the shape of mistake that reports ZERO for every population while every
// subject matched — arithmetically identical to a whole cohort out of the initial population, and it
// cost a debugging pass here. Typed so it cannot recur.
const countTrue = (people: ReadonlyArray<OfficialSubjectResult | undefined>, fqmKey: string): number =>
  people.filter((p) => p?.populations?.[fqmKey] === true).length;

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const files = readdirSync(args.docs).filter((f) => f.endsWith(".xml")).sort();
  if (files.length === 0) throw new Error(`no .xml documents in ${args.docs}`);

  // ---- import -------------------------------------------------------------------------------------
  const byPerson = new Map<string, Array<{ file: string; bundle: { entry?: Array<{ resource: unknown }> } }>>();
  const labels = new Map<string, string>();
  const untranslated = new Map<string, number>();
  const importFailures: Array<{ file: string; message: string }> = [];
  let documentsWithoutMbi = 0;

  for (const file of files) {
    const xml = readFileSync(path.join(args.docs, file), "utf8");
    const identity = identityKey(xml);
    if (!identity.mbi) documentsWithoutMbi++;
    try {
      const imported = importQrda1Document(xml);
      for (const template of imported.untranslatedTemplates) {
        untranslated.set(template, (untranslated.get(template) ?? 0) + 1);
      }
      const list = byPerson.get(identity.key) ?? [];
      list.push({ file, bundle: imported.bundle as { entry?: Array<{ resource: unknown }> } });
      byPerson.set(identity.key, list);
      labels.set(identity.key, identity.label);
    } catch (error) {
      importFailures.push({ file, message: String((error as Error)?.message ?? error) });
    }
  }

  const people: Person[] = [...byPerson.entries()].map(([key, docs]) => mergeDocuments(docs, key, labels.get(key) ?? key));

  // ---- calculate ----------------------------------------------------------------------------------
  const artifact = loadOfficialArtifact(args.measure);
  if (!artifact) throw new Error(`${args.measure}: no executable official artifact is vendored`);
  const valueSetCache = await expandArtifactTerminology(artifact, officialTerminologyExpander(loadOfficialArtifact));

  const subjects = args.byDocument
    ? files.flatMap((file) => {
        const xml = readFileSync(path.join(args.docs, file), "utf8");
        try {
          const imported = importQrda1Document(xml);
          return [{ key: file, label: file, documents: [file], bundle: imported.bundle as Person["bundle"] }];
        } catch {
          return [];
        }
      })
    : people;

  const evaluate = async (period: { start: string; end: string }) => {
    const patientBundles = subjects.map((s) => preparedForQiCore(s.bundle as PreparableBundle));
    const { bySubject, retrieveSignal } = await calculateOfficialWithSignal({
      bundle: artifact.bundle as never,
      patientBundles,
      period,
      valueSetCache,
    });
    // fqm keys by `Patient.id`; ours is the sanitized identity key (or the file, in --by-document).
    const membership = subjects.map((s) => bySubject.get(patientIdOf(s.bundle)));
    if (process.env.C2_DEBUG) {
      console.error(`[c2] fqm returned ${bySubject.size} subject(s); first membership:`, JSON.stringify(membership[0]));
    }
    const unmatched = subjects.filter((_, i) => membership[i] === undefined).length;
    if (unmatched > 0) {
      // Never silently: an unmatched subject counts as "in no population", which is arithmetically
      // indistinguishable from a correct out-of-population answer and would read as an engine defect.
      console.error(
        `[c2] WARNING: ${unmatched} of ${subjects.length} subject(s) had no fqm result. ` +
          `fqm keys: ${[...bySubject.keys()].slice(0, 3).join(", ")} | ours: ` +
          `${subjects.slice(0, 3).map((s) => patientIdOf(s.bundle)).join(", ")}`,
      );
    }
    return { membership, retrieveSignal };
  };

  const cypressPeriod = { start: args.periodStart, end: args.periodEnd };
  const primary = await evaluate(cypressPeriod);

  // ---- report -------------------------------------------------------------------------------------
  const out: string[] = [];
  out.push(`# Cypress C2 calculation check — ${args.measure}`, "");
  out.push(`- documents: **${files.length}**`);
  out.push(`- resolved to: **${people.length} people** (${documentsWithoutMbi} document(s) carried no MBI)`);
  out.push(`- evaluated as: **${subjects.length} subject(s)** (${args.byDocument ? "one per DOCUMENT" : "one per PERSON"})`);
  out.push(`- measurement period: **${cypressPeriod.start} … ${cypressPeriod.end}** (Cypress's own)`);
  out.push(`- retrieve signal: ${primary.retrieveSignal ? "yes" : "**NO — nothing matched for anybody**"}`);
  if (importFailures.length > 0) {
    out.push("", `**${importFailures.length} document(s) failed to import:**`);
    for (const f of importFailures.slice(0, 10)) out.push(`- \`${f.file}\`: ${f.message}`);
  }
  if (untranslated.size > 0) {
    out.push("", `**Untranslated QDM templates** (an entry we cannot read is a population difference waiting to happen):`);
    for (const [template, count] of [...untranslated.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`- \`${template}\` × ${count}`);
    }
  }

  const reported: Record<string, number> = {};
  for (const [cypressKey, fqmKey] of POPULATION_KEYS) reported[cypressKey] = countTrue(primary.membership, fqmKey);

  const expected = readExpected(args);
  out.push("", "## Populations", "");
  out.push("| population | expected (Cypress) | reported (WorkWell) | |", "|---|---|---|---|");
  for (const [cypressKey] of POPULATION_KEYS) {
    const e = expected?.[cypressKey];
    const r = reported[cypressKey]!;
    if (e === undefined && r === 0) continue;
    const mark = e === undefined ? "(not in expected)" : e === r ? "MATCH" : "**MISMATCH**";
    out.push(`| ${cypressKey} | ${e ?? "—"} | ${r} | ${mark} |`);
  }

  // Per-SUBJECT, where the file is available. An aggregate difference says "23 patients disagree"; this
  // says which 23 and in which direction, which is the difference between a number and a diagnosis.
  const perPatient = args.perPatient ? readPerPatient(args) : undefined;
  if (perPatient) {
    const rows: string[] = [];
    const byPopulation = new Map<string, { weOnly: number; theyOnly: number }>();
    let compared = 0;
    let unmatchedSubjects = 0;
    subjects.forEach((subject, i) => {
      const expectedRow = perPatient[subject.key.replace(/^mbi:/, "")] ?? perPatient[subject.key];
      if (!expectedRow) {
        unmatchedSubjects++;
        return;
      }
      compared++;
      const diffs: string[] = [];
      for (const [cypressKey, fqmKey] of POPULATION_KEYS) {
        const theirs = (expectedRow[cypressKey] ?? 0) > 0;
        const ours = primary.membership[i]?.populations?.[fqmKey] === true;
        if (theirs === ours) continue;
        const tally = byPopulation.get(cypressKey) ?? { weOnly: 0, theyOnly: 0 };
        if (ours) tally.weOnly++;
        else tally.theyOnly++;
        byPopulation.set(cypressKey, tally);
        diffs.push(`${cypressKey}: cypress=${theirs ? 1 : 0} workwell=${ours ? 1 : 0}`);
      }
      if (diffs.length > 0) rows.push(`- \`${subject.label}\` (${subject.documents.length} doc): ${diffs.join("; ")}`);
    });
    out.push("", "## Per-subject comparison", "");
    out.push(`- subjects compared: **${compared}** of ${subjects.length}${unmatchedSubjects > 0 ? ` (**${unmatchedSubjects} unmatched by identifier**)` : ""}`);
    out.push(`- subjects agreeing on every population: **${compared - rows.length}**`, "");
    for (const [population, tally] of byPopulation) {
      out.push(`- \`${population}\`: **${tally.theyOnly}** subject(s) Cypress includes and we do not; **${tally.weOnly}** we include and Cypress does not`);
    }
    if (rows.length > 0) out.push("", `**${rows.length} differing subject(s):**`, ...rows.slice(0, 60));
  }

  // Whether the engine computes NUMER independently of DENEX decides how the two columns above may be
  // read. If a subject can be BOTH excluded and numerator-positive, a raw numerator count is not
  // comparable to Cypress's, and a numerator "mismatch" may be nothing but that convention — so it is
  // measured rather than argued about.
  const both = primary.membership.filter(
    (m) => m?.populations?.["denominator-exclusion"] === true && m?.populations?.["numerator"] === true,
  ).length;
  const excluded = countTrue(primary.membership, "denominator-exclusion");
  out.push(
    "",
    "## Are NUMER and DENEX independent here?",
    "",
    `- subjects reported in BOTH \`denominator-exclusion\` and \`numerator\`: **${both}** of ${excluded} excluded`,
    both > 0
      ? "  → the executor reports population membership INDEPENDENTLY; our numerator count is not " +
        "directly comparable to Cypress's without subtracting exclusions."
      : "  → no subject is in both, so the two counts are comparable as printed.",
  );

  if (args.alsoRolling) {
    // ADR-039's rolling window, i.e. what the RUNTIME would evaluate. Measured rather than reasoned
    // about: if it moves nobody, prerequisite 11.2 is a smaller risk than it reads.
    const rollingEval = args.periodEnd.slice(0, 10);
    const rolling = officialMeasurementPeriod(args.measure, rollingEval);
    const second = await evaluate(rolling);
    const moved = subjects
      .map((s, i) => ({ s, a: primary.membership[i], b: second.membership[i] }))
      .filter(({ a, b }) => POPULATION_KEYS.some(([, fqm]) => (a?.populations?.[fqm] === true) !== (b?.populations?.[fqm] === true)));
    out.push("", "## Rolling window (what the runtime would use)", "");
    out.push(`- rolling period: **${rolling.start} … ${rolling.end}** (\`officialMeasurementPeriod('${args.measure}', '${rollingEval}')\`)`);
    out.push(
      `- subjects whose population membership differs from the Cypress window: **${moved.length}**`,
      ...moved.slice(0, 20).map(({ s, a, b }) => `  - \`${s.label}\`: ${JSON.stringify(a?.populations)} → ${JSON.stringify(b?.populations)}`),
    );
  }

  console.log(out.join("\n"));
  return 0;
}

/** Cypress's per-patient populations, keyed by MBI (or a `dem:`-prefixed demographic fallback). */
function readPerPatient(args: Args): Record<string, Record<string, number>> | undefined {
  const raw = JSON.parse(readFileSync(args.perPatient!, "utf8")) as Record<string, Record<string, Record<string, number>>>;
  const key = args.perPatientKey ?? Object.keys(raw)[0];
  return key ? raw[key] : undefined;
}

function readExpected(args: Args): Record<string, number> | undefined {
  if (!args.expected) return undefined;
  const raw = JSON.parse(readFileSync(args.expected, "utf8")) as Record<string, unknown>;
  // Accepts the oracle snapshot (`tests.<CMSxxxvNN>.expected.PopulationSet_1`) written by the C2 rebuild.
  const tests = (raw as { tests?: Record<string, { expected?: Record<string, Record<string, number>> }> }).tests;
  const key = args.expectedKey ?? Object.keys(tests ?? {})[0];
  const sets = key ? tests?.[key]?.expected : undefined;
  return sets?.["PopulationSet_1"];
}

if (process.argv[1]?.endsWith("c2-calculation-check.ts")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
