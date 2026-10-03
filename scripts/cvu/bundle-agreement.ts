#!/usr/bin/env -S node --import tsx
/**
 * Per-patient agreement between WorkWell's FHIR execution and a Cypress bundle's own expected results.
 *
 * A Cypress measure bundle carries, for every test patient and measure, Cypress's precalculated
 * populations (`calculations/individual-results/*.json`) next to the patient as a QRDA Category I
 * (`patients/*.xml`). This script imports each patient through `qrda1-import.ts`, runs the measure's
 * official FHIR artifact over them with the bundle's own measurement period, and compares every
 * population of every rate, patient by patient. No Cypress server is needed, unlike `c2-calculation-check.ts`,
 * which grades Cypress's split-and-duplicated product-test archives.
 *
 *   cd backend-ts && corepack pnpm@10 exec node --import tsx ../scripts/cvu/bundle-agreement.ts \
 *     --bundle-dir C:/cvu-data/cypress/bundle-2026 --measure cms125 [--valuesets-dir C:/cvu-data/vsac-2027]
 *
 * `--bundle-dir` is an EXTRACTED bundle zip. Bundles and value sets are licensed (UMLS): keep them outside
 * the repository and never commit what this prints beyond aggregate counts.
 *
 * `--valuesets-dir` swaps the artifact's vendored terminology for FHIR ValueSet expansions on disk (one
 * JSON per value set), so a value-set vintage difference can be told apart from a logic difference.
 *
 * Each measure runs the way production runs it: `trustMetaProfile` comes from the measure's semantics
 * (`official-measure-semantics.ts`), and the mode is printed. `--trust-meta-profile on|off` overrides it
 * for diagnosis only, and the output says so; a number from an overridden run is not what the QRDA I
 * route would produce.
 *
 * Descriptive only: it writes nothing and authors no compliance status.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import { importQrda1Document } from "../../backend-ts/src/fhir/qrda1-import.ts";
import { loadOfficialArtifact } from "../../backend-ts/src/wiring/official-artifacts.ts";
import { officialTerminologyExpander } from "../../backend-ts/src/wiring/official-terminology.ts";
import { expandArtifactTerminology } from "../../backend-ts/src/wiring/official-executor-adapter.ts";
import { preparedForQiCore, type PreparableBundle } from "../../backend-ts/src/wiring/qicore-preparation.ts";
import { officialMeasureSemantics } from "../../backend-ts/src/wiring/official-measure-semantics.ts";
import {
  calculateOfficialWithSignal,
  type OfficialSubjectResult,
} from "../../backend-ts/packages/official-executor/src/index.ts";

/** Cypress population keys → fqm population types. */
const POPULATIONS: ReadonlyArray<[cypress: string, fqm: string]> = [
  ["IPP", "initial-population"],
  ["DENOM", "denominator"],
  ["DENEX", "denominator-exclusion"],
  ["DENEXCEP", "denominator-exception"],
  ["NUMER", "numerator"],
  ["NUMEX", "numerator-exclusion"],
];

interface Args {
  bundleDir: string;
  measure: string;
  valuesetsDir?: string;
  trustMetaProfile?: boolean;
  limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bundleDir = get("--bundle-dir");
  const measure = get("--measure");
  if (!bundleDir || !measure) {
    throw new Error("usage: --bundle-dir <extracted bundle> --measure <cms id> [--valuesets-dir <dir>] [--trust-meta-profile on|off] [--limit 40]");
  }
  const trust = get("--trust-meta-profile");
  if (trust !== undefined && trust !== "on" && trust !== "off") throw new Error("--trust-meta-profile takes on or off");
  return {
    bundleDir,
    measure,
    valuesetsDir: get("--valuesets-dir"),
    ...(trust ? { trustMetaProfile: trust === "on" } : {}),
    limit: Number(get("--limit") ?? 40),
  };
}

const csvRows = (file: string): string[][] =>
  readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => line.split(","));

/** The bundle's CMS number for our catalog id: `cms125` → `CMS125`. */
const cmsPrefix = (measureId: string): string => measureId.toUpperCase();

interface Expected {
  patientId: string;
  set: number; // 0-based rate index
  values: Record<string, number>;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const dir = args.bundleDir;
  const bundleMeta = JSON.parse(readFileSync(path.join(dir, "bundle.json"), "utf8")) as {
    version: string;
    title: string;
    measure_period_start: number;
    effective_date: number;
  };
  const day = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
  const period = { start: day(bundleMeta.measure_period_start), end: day(bundleMeta.effective_date) };

  // The bundle's measure for our id, e.g. cms125 → CMS125v15.
  const measureRows = csvRows(path.join(dir, "calculations", "measure-id-mapping.csv"));
  const wanted = measureRows.filter(([, cms]) => new RegExp(`^${cmsPrefix(args.measure)}v\\d+$`).test(cms ?? ""));
  if (wanted.length !== 1) throw new Error(`${args.measure}: expected one bundle measure, found ${wanted.map((r) => r[1]).join(", ") || "none"}`);
  const [bundleMeasureId, bundleMeasureName] = wanted[0]!;

  // Patient id → its QRDA file. Files are named `<given>_<family>.xml` with spaces as underscores.
  const fileOf = new Map(
    csvRows(path.join(dir, "calculations", "patient-id-mapping.csv")).map(([id, given, family]) => [
      id!,
      `${given}_${family}`.replace(/\s+/g, "_") + ".xml",
    ]),
  );

  // Cypress's expected populations for this measure, per patient and population set. Strata are counted
  // and reported, not compared.
  const expected: Expected[] = [];
  let strata = 0;
  const resultsDir = path.join(dir, "calculations", "individual-results");
  for (const file of readdirSync(resultsDir)) {
    const r = JSON.parse(readFileSync(path.join(resultsDir, file), "utf8")) as Record<string, unknown>;
    if (r.measure_id !== bundleMeasureId) continue;
    const key = String(r.population_set_key ?? "");
    const set = /^PopulationSet_(\d+)$/.exec(key);
    if (!set) {
      strata++;
      continue;
    }
    const values: Record<string, number> = {};
    for (const [cypress] of POPULATIONS) values[cypress] = Number(r[cypress] ?? 0);
    expected.push({ patientId: String(r.patient_id), set: Number(set[1]) - 1, values });
  }
  const patientIds = [...new Set(expected.map((e) => e.patientId))];

  // Import each patient once.
  const untranslated = new Map<string, number>();
  const importFailures: string[] = [];
  const bundles: unknown[] = [];
  const importedIds = new Set<string>();
  for (const id of patientIds) {
    const file = fileOf.get(id);
    const full = file ? path.join(dir, "patients", file) : "";
    if (!file || !existsSync(full)) {
      importFailures.push(`${id}: no patient file (${file ?? "unmapped"})`);
      continue;
    }
    try {
      const imported = importQrda1Document(readFileSync(full, "utf8"));
      for (const t of imported.untranslatedTemplates) untranslated.set(t, (untranslated.get(t) ?? 0) + 1);
      const b = imported.bundle as { entry: Array<{ resource: Record<string, unknown> }> };
      const patient = b.entry.find((e) => e.resource.resourceType === "Patient");
      if (patient) patient.resource.id = id; // key fqm's result by the bundle's patient id
      bundles.push(preparedForQiCore(b as unknown as PreparableBundle));
      importedIds.add(id);
    } catch (error) {
      importFailures.push(`${id} (${file}): ${String((error as Error)?.message ?? error)}`);
    }
  }

  const artifact = loadOfficialArtifact(args.measure);
  if (!artifact) throw new Error(`${args.measure}: no official artifact is vendored`);
  const vendored = (await expandArtifactTerminology(artifact, officialTerminologyExpander(loadOfficialArtifact))) as Array<{ url?: string }>;
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

  const semantics = officialMeasureSemantics(args.measure);
  const productionTrust = semantics?.trustMetaProfile ?? false;
  const trustMetaProfile = args.trustMetaProfile ?? productionTrust;
  const mode =
    `trustMetaProfile ${trustMetaProfile ? "on" : "off"}` +
    (!semantics
      ? " (production has no recorded semantics for this measure and refuses to run it)"
      : trustMetaProfile === productionTrust
        ? " (as production runs this measure)"
        : ` (OVERRIDDEN: production runs it ${productionTrust ? "on" : "off"})`);

  const header = (): string[] => [
    `# Agreement: ${args.measure} vs ${bundleMeasureName} (${bundleMeta.version})`,
    "",
    `- bundle: ${bundleMeta.title}`,
    `- measurement period: ${period.start} … ${period.end}`,
    `- artifact: vendored official ${args.measure}; terminology: ${args.valuesetsDir ? `on disk (${args.valuesetsDir}), ${fellBack.length} value set(s) not on disk kept vendored` : "vendored sidecar"}`,
    ...fellBack.map((url) => `  - vendored: \`${url}\``),
    `- engine: ${mode}`,
  ];

  const run = async (patientBundles: unknown[]) =>
    (await calculateOfficialWithSignal({ bundle: artifact.bundle as never, patientBundles, period, valueSetCache, options: { trustMetaProfile } })).bySubject;
  const bySubject = new Map<string, OfficialSubjectResult>();
  const engineErrors = new Map<string, number>(); // first line of the message -> patients
  try {
    for (const [id, result] of await run(bundles)) bySubject.set(id, result);
  } catch {
    // One patient that throws rejects fqm's whole batch. The QRDA I route evaluates each subject on its own
    // and records a failure for that subject only, so retry one patient at a time and do the same.
    for (const one of bundles) {
      try {
        for (const [id, result] of await run([one])) bySubject.set(id, result);
      } catch (error) {
        const line = String((error as Error)?.message ?? error).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ");
        engineErrors.set(line, (engineErrors.get(line) ?? 0) + 1);
      }
    }
  }

  // Compare. Rates are matched by position: Cypress's `PopulationSet_N` is the measure's Nth group, which
  // is also the order fqm returns them in for every measure here.
  const bySet = new Map<number, { agree: number; total: number; expected: Record<string, number>; reported: Record<string, number> }>();
  const disagreements: string[] = [];
  for (const e of expected) {
    const result: OfficialSubjectResult | undefined = bySubject.get(e.patientId);
    const tally = bySet.get(e.set) ?? { agree: 0, total: 0, expected: {}, reported: {} };
    bySet.set(e.set, tally);
    tally.total++;
    // Expected counts include every patient, so a missing engine result shows as a shortfall in the
    // reported column instead of shrinking both.
    for (const [c] of POPULATIONS) tally.expected[c] = (tally.expected[c] ?? 0) + (e.values[c] ? 1 : 0);
    if (!result) {
      for (const [c] of POPULATIONS) tally.reported[c] = tally.reported[c] ?? 0;
      continue;
    }
    const rate = result.rates[e.set] ?? [];
    const got: Record<string, number> = {};
    for (const [cypress, fqm] of POPULATIONS) got[cypress] = rate.some((p) => p.populationType === fqm && p.result) ? 1 : 0;
    const diffs = POPULATIONS.filter(([c]) => (e.values[c] ? 1 : 0) !== got[c]).map(([c]) => `${c} ${e.values[c] ? 1 : 0}→${got[c]}`);
    for (const [c] of POPULATIONS) tally.reported[c] = (tally.reported[c] ?? 0) + got[c]!;
    if (diffs.length === 0) tally.agree++;
    else if (disagreements.length < args.limit) disagreements.push(`- set ${e.set + 1} \`${fileOf.get(e.patientId)}\`: ${diffs.join(", ")}`);
  }

  const out: string[] = header();
  // Per patient, not per rate: a patient missing from a two-rate measure is one patient.
  const noResult = [...importedIds].filter((id) => !bySubject.has(id)).length;
  out.push(`- patients: ${patientIds.length} (${importFailures.length} not imported, ${noResult} imported with no engine result); strata rows not compared: ${strata}`);
  if (engineErrors.size) {
    out.push("", "## Engine errors", "");
    for (const [line, n] of engineErrors) out.push(`- ${n} patient(s): ${line}`);
  }
  out.push("", "| set | patients agreeing | " + POPULATIONS.map(([c]) => c).join(" | ") + " |", "|---|---|" + POPULATIONS.map(() => "---|").join(""));
  for (const [set, t] of [...bySet.entries()].sort((a, b) => a[0] - b[0])) {
    const cells = POPULATIONS.map(([c]) => `${t.expected[c]} / ${t.reported[c]}`);
    out.push(`| ${set + 1} | ${t.agree}/${t.total} | ${cells.join(" | ")} |`);
  }
  out.push("", "Cells are expected (Cypress) / reported (WorkWell).");
  if (disagreements.length) out.push("", `## Disagreements (first ${args.limit})`, "", ...disagreements);
  if (untranslated.size) {
    out.push("", "## Untranslated QDM templates", "");
    for (const [t, n] of [...untranslated.entries()].sort((a, b) => b[1] - a[1])) out.push(`- \`${t}\` × ${n}`);
  }
  if (importFailures.length) out.push("", "## Import failures", "", ...importFailures.slice(0, 20).map((f) => `- ${f}`));
  console.log(out.join("\n"));
  return engineErrors.size ? 2 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bundle-agreement.ts")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
