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
 *     --docs ../cvu-workdir/c2/passB/CMS122v14 --measure cms122 \
 *     --expected ../cvu-workdir/c2/passB/snapshot.json --expected-key CMS122v14 \
 *     --per-patient ../cvu-workdir/c2/passB/per-patient.json --per-patient-key CMS122v14 \
 *     --period-start 2024-01-01 --period-end 2024-12-31
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
 * 3. **A dropped datatype is a silent wrong answer.** Every untranslated QDM template and a tally of the
 *    resources actually produced are reported, because an entry this importer cannot read is a population
 *    difference waiting to happen — and `--inject` turns "that datatype is the cause" into an experiment.
 *
 * ## What it checks about ITSELF, because a wrong harness reports a plausible number rather than an error
 *
 * - **people resolved vs the oracle's patient count.** The single direct detector for an over-merge (a
 *   demographic-key collision), an under-merge (an MBI that did not parse) or a person lost to an import
 *   failure. Without it all three surface only as a population mismatch — i.e. as an apparent ENGINE
 *   defect, which is the most expensive way to be wrong here.
 * - **the per-patient rows summing to the aggregate.** Exactly what oracle contamination breaks: a
 *   re-run of `ProductTestSetupJob` doubles the aggregate while leaving per-patient rows untouched.
 * - **demographic conflicts inside a merged person.** See `mergeDocuments` — this one can manufacture a
 *   false MATCH, so it is reported rather than resolved.
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
  perPatient?: string;
  perPatientKey?: string;
  periodStart: string;
  periodEnd: string;
  alsoRolling: boolean;
  byDocument: boolean;
  inject?: string;
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
    else if (arg === "--inject") args.inject = argv[++i];
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
  // Comparing against another measure's rows silently reports "0 of N compared" rather than failing.
  if (args.perPatient && !args.perPatientKey) {
    throw new Error("--per-patient requires --per-patient-key (e.g. CMS122v14); the file holds every test");
  }
  return args as Args;
}

/** `<id extension=… root=…>` in either attribute order — CDA does not fix one, and Cypress's choice is not a contract. */
function recordTargetIds(recordTarget: string): Array<{ root: string; extension: string }> {
  return [...recordTarget.matchAll(/<id\s[^>]*\/?>/g)].flatMap((m) => {
    const root = /\sroot="([^"]+)"/.exec(m[0])?.[1];
    const extension = /\sextension="([^"]+)"/.exec(m[0])?.[1];
    return root && extension ? [{ root, extension }] : [];
  });
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
  const ids = recordTargetIds(rt);
  const mbi = ids.find((i) => i.root === MBI_ROOT)?.extension ?? null;
  const mrn = ids.find((i) => i.root === MRN_ROOT)?.extension ?? null;
  const given = [...rt.matchAll(/<given>([^<]*)<\/given>/g)].map((m) => m[1]).join(" ");
  const family = /<family>([^<]*)<\/family>/.exec(rt)?.[1] ?? "";
  const birth = /<birthTime[^>]*value=["']([^"']+)["']/.exec(rt)?.[1] ?? "";
  const label = `${given} ${family}`.trim();
  return { key: mbi ? `mbi:${mbi}` : `dem:${label}|${birth}`, mbi, mrn, label };
}

interface Person {
  key: string;
  /** The label of the document whose Patient was EVALUATED — never a different one. */
  label: string;
  documents: string[];
  bundle: { resourceType: "Bundle"; type: "collection"; entry: Array<{ resource: unknown }> };
  /** Fields on which this person's documents disagree, and what each said. */
  conflicts: Array<{ field: string; values: string[] }>;
}

/**
 * Merge every document belonging to one person into a single bundle.
 *
 * The importer emits no subject references (resources stand alone in a per-patient bundle), so a merge
 * is a union of clinical resources under ONE document's Patient. Resource ids are namespaced by document
 * index: two documents for the same person can legitimately carry the same generated id, and a collision
 * would silently drop half a split patient's data — the exact failure this merge exists to prevent.
 *
 * **Which Patient wins is arbitrary, and that can manufacture a FALSE MATCH — so conflicts are REPORTED,
 * never resolved.** Cypress randomises the duplicate's first name, last name *or* birthdate, and both
 * artifacts gate the initial population on `AgeInYearsAt(...)`. So a person whose two documents disagree
 * on `birthDate` has two defensible answers, only one of which the oracle used, and picking silently
 * would let the harness print MATCH while discarding a birthdate it was handed. Review of this file
 * reproduced exactly that by mutating a birthdate in the document that does NOT win. Nothing bit in the
 * measured passes only because Cypress happened to randomise names — a `rand_seed` property, not an
 * invariant.
 *
 * The reported `label` is taken from the same document as the evaluated Patient, so a reader who opens
 * the named file sees the demographics that were actually used.
 */
export function mergeDocuments(
  docs: ReadonlyArray<{ file: string; label: string; bundle: { entry?: Array<{ resource: unknown }> } }>,
  key: string,
): Person {
  const entries: Array<{ resource: unknown }> = [];
  const patients: Array<{ file: string; label: string; resource: Record<string, unknown> }> = [];
  docs.forEach((doc, index) => {
    for (const entry of doc.bundle.entry ?? []) {
      const resource = entry.resource as { resourceType?: string; id?: string };
      if (resource?.resourceType === "Patient") {
        patients.push({ file: doc.file, label: doc.label, resource: resource as Record<string, unknown> });
        continue;
      }
      entries.push({ resource: { ...resource, id: `${index}-${resource?.id ?? entries.length}` } });
    }
  });

  const chosen = patients[0];
  const conflicts: Array<{ field: string; values: string[] }> = [];
  const compare = (field: string, read: (p: Record<string, unknown>) => string) => {
    const values = [...new Set(patients.map((p) => read(p.resource)))];
    if (values.length > 1) conflicts.push({ field, values });
  };
  if (patients.length > 1) {
    compare("birthDate", (p) => String(p.birthDate ?? ""));
    compare("gender", (p) => String(p.gender ?? ""));
    compare("name", (p) => JSON.stringify(p.name ?? []));
  }

  if (chosen) entries.unshift({ resource: { ...chosen.resource, id: sanitizeId(key) } });
  return {
    key,
    label: chosen?.label ?? key,
    documents: docs.map((d) => d.file),
    bundle: { resourceType: "Bundle", type: "collection", entry: entries },
    conflicts,
  };
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
  const byPerson = new Map<string, Array<{ file: string; label: string; bundle: { entry?: Array<{ resource: unknown }> } }>>();
  const untranslated = new Map<string, number>();
  const produced = new Map<string, number>();
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
      for (const entry of (imported.bundle as { entry: Array<{ resource: { resourceType: string } }> }).entry) {
        produced.set(entry.resource.resourceType, (produced.get(entry.resource.resourceType) ?? 0) + 1);
      }
      const list = byPerson.get(identity.key) ?? [];
      list.push({ file, label: identity.label, bundle: imported.bundle as { entry?: Array<{ resource: unknown }> } });
      byPerson.set(identity.key, list);
    } catch (error) {
      importFailures.push({ file, message: String((error as Error)?.message ?? error) });
    }
  }

  const people: Person[] = [...byPerson.entries()].map(([key, docs]) => mergeDocuments(docs, key));

  // ---- calculate ----------------------------------------------------------------------------------
  const artifact = loadOfficialArtifact(args.measure);
  if (!artifact) throw new Error(`${args.measure}: no executable official artifact is vendored`);
  const valueSetCache = await expandArtifactTerminology(artifact, officialTerminologyExpander(loadOfficialArtifact));

  const subjects: Person[] = args.byDocument
    ? files.flatMap((file) => {
        const xml = readFileSync(path.join(args.docs, file), "utf8");
        try {
          const imported = importQrda1Document(xml);
          return [{ key: file, label: file, documents: [file], bundle: imported.bundle as Person["bundle"], conflicts: [] }];
        } catch {
          return [];
        }
      })
    : people;

  // `--inject`: add FHIR resources to one named subject and report the before/after populations. This is
  // how "the cause is the datatype we drop" becomes an experiment rather than a correlation — supply the
  // resource the importer skipped and see whether the population moves to the oracle's answer.
  const injection = args.inject
    ? (JSON.parse(readFileSync(args.inject, "utf8")) as { subjectLabel: string; resources: unknown[] })
    : undefined;
  let injected: Person | undefined;
  if (injection) {
    const target = subjects.find((s) => s.label === injection.subjectLabel);
    if (!target) throw new Error(`--inject names subject '${injection.subjectLabel}', which is not in ${args.docs}`);
    const copy = structuredClone(target.bundle);
    injection.resources.forEach((resource, i) => copy.entry.push({ resource }));
    injected = { ...target, key: `${target.key}|injected`, bundle: copy };
  }

  const unmatchedNotes: string[] = [];
  const evaluate = async (period: { start: string; end: string }, over: readonly Person[] = subjects) => {
    const patientBundles = over.map((s) => preparedForQiCore(s.bundle as PreparableBundle));
    const { bySubject, retrieveSignal } = await calculateOfficialWithSignal({
      bundle: artifact.bundle as never,
      patientBundles,
      period,
      valueSetCache,
    });
    // fqm keys by `Patient.id`; ours is the sanitized identity key (or the file, in --by-document).
    const membership = over.map((s) => bySubject.get(patientIdOf(s.bundle)));
    const unmatched = over.filter((_, i) => membership[i] === undefined).length;
    if (unmatched > 0) {
      // In the REPORT, not on stderr: a subject fqm returned nothing for counts as "in no population",
      // which is arithmetically indistinguishable from a correct out-of-population answer. The report is
      // routinely redirected to a file, so a warning on stderr can sit unread beside a clean-looking table.
      unmatchedNotes.push(
        `**${unmatched} of ${over.length} subject(s) had no fqm result** over ${period.start}…${period.end}. ` +
          `fqm keys: ${[...bySubject.keys()].slice(0, 3).join(", ")} | ours: ` +
          `${over.slice(0, 3).map((s) => patientIdOf(s.bundle)).join(", ")}`,
      );
    }
    return { membership, retrieveSignal };
  };

  const cypressPeriod = { start: args.periodStart, end: args.periodEnd };
  const primary = await evaluate(cypressPeriod);

  // ---- report -------------------------------------------------------------------------------------
  const out: string[] = [];
  const expectedPatients = readOracle(args)?.patients;
  out.push(`# Cypress C2 calculation check — ${args.measure}`, "");
  out.push(`- documents: **${files.length}**`);
  out.push(`- resolved to: **${people.length} people** (${documentsWithoutMbi} document(s) carried no MBI)`);
  // The single direct detector for an identity artefact. Without it, an over-merge, an under-merge and a
  // lost person all surface only as a population mismatch — i.e. as an apparent engine defect.
  if (expectedPatients !== undefined) {
    out.push(
      people.length === expectedPatients
        ? `- **people resolved == the oracle's ${expectedPatients} patients** — identity resolution checks out`
        : `- **IDENTITY MISMATCH: ${people.length} people resolved, oracle has ${expectedPatients} patients.** ` +
          `Every population number below is suspect: this is a harness defect until proven otherwise, not an engine one.`,
    );
  }
  out.push(`- evaluated as: **${subjects.length} subject(s)** (${args.byDocument ? "one per DOCUMENT" : "one per PERSON"})`);
  out.push(`- measurement period: **${cypressPeriod.start} … ${cypressPeriod.end}** (Cypress's own)`);
  out.push(`- retrieve signal: ${primary.retrieveSignal ? "yes" : "**NO — nothing matched for anybody**"}`);
  for (const note of unmatchedNotes) out.push(`- ${note}`);

  const conflicted = people.filter((p) => p.conflicts.length > 0);
  if (conflicted.length > 0) {
    out.push(
      "",
      `**${conflicted.length} merged person(s) whose documents DISAGREE on demographics.** The Patient ` +
        `evaluated is the one from the document named below; the other value was discarded. A \`birthDate\` ` +
        `conflict is load-bearing — both artifacts gate the initial population on \`AgeInYearsAt(...)\` — so ` +
        `a MATCH on a conflicted person may be an artefact of which document happened to sort first:`,
    );
    for (const p of conflicted) {
      out.push(`- \`${p.label}\` (evaluated) vs ${p.documents.length - 1} other doc(s): ` +
        p.conflicts.map((c) => `**${c.field}** ${JSON.stringify(c.values)}`).join("; "));
    }
  }

  if (importFailures.length > 0) {
    out.push("", `**${importFailures.length} document(s) failed to import:**`);
    for (const f of importFailures.slice(0, 10)) out.push(`- \`${f.file}\`: ${f.message}`);
  }
  out.push("", "**Resources produced by the importer** (the direct measure of what survived translation):", "");
  for (const [type, n] of [...produced.entries()].sort((a, b) => b[1] - a[1])) out.push(`- ${type} × ${n}`);
  if (untranslated.size > 0) {
    out.push(
      "",
      "**Untranslated QDM templates** — an entry we cannot read is a population difference waiting to happen.",
      "These are DATATYPE templates: the importer used to report the last templateId in the entry, which is",
      "routinely a nested ATTRIBUTE template (Author dateTime `…24.3.155`, Rank `…24.3.166`); fixed in",
      "ADR-055. Cross-check against the resource tally above, which is the direct measure of what survived.",
      "",
    );
    for (const [template, count] of [...untranslated.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`- \`${template}\` × ${count}`);
    }
  }

  const reported: Record<string, number> = {};
  for (const [cypressKey, fqmKey] of POPULATION_KEYS) reported[cypressKey] = countTrue(primary.membership, fqmKey);

  const expected = readExpected(args);
  const uncompared = uncomparedSets(args);
  out.push("", "## Populations", "");
  if (uncompared.length > 0) {
    // A stratified measure can agree on the unstratified set and disagree WITHIN a stratum, and a C2
    // submission is graded on every set. fqm reports stratifier results, but the official-executor
    // package does not surface them (`detailedResults[0]` only), so this harness cannot compare them —
    // and a table that showed only `PopulationSet_1` while calling itself the C2 comparison would read
    // as a clean result over a partial one (Codex, #387).
    out.push(
      `> **PARTIAL: this compares \`PopulationSet_1\` only.** The oracle also carries ` +
        uncompared.map((u) => `\`${u.name}\` (${JSON.stringify(u.counts)})`).join(", ") +
        `, which a real C2 submission is graded on. The executor package does not surface fqm's ` +
        `stratifier results, so they are NOT checked here — do not read the table below as the ` +
        `complete comparison.`,
      "",
    );
  }
  out.push("| population | expected (Cypress) | reported (WorkWell) | |", "|---|---|---|---|");
  for (const [cypressKey] of POPULATION_KEYS) {
    const e = expected?.[cypressKey];
    const r = reported[cypressKey]!;
    if (e === undefined && r === 0) continue;
    const mark = e === undefined ? "(not in expected)" : e === r ? "MATCH" : "**MISMATCH**";
    out.push(`| ${cypressKey} | ${e ?? "—"} | ${r} | ${mark} |`);
  }
  out.push(
    "",
    "Two properties of these artifacts that decide how the table may be READ, both verified in the vendored",
    "bundles rather than assumed:",
    "",
    "- **`Denominator` is an `ExpressionRef` to `Initial Population`** in both CMS122 and CMS125, so the",
    "  DENOM row is the IPP row restated — one agreement, not two.",
    "- **fqm zeroes NUMER whenever DENEX is true** for a proportion measure with a single initial population",
    "  (`DetailedResultsBuilder.handleStandardPopulationValues`). So a numerator difference cannot be read",
    "  apart from the exclusions: missed exclusions move subjects INTO the numerator by construction, and for",
    "  an INVERSE measure like CMS122 that is the direction that looks like non-compliance.",
  );

  // Per-SUBJECT, where the file is available. An aggregate difference says "23 patients disagree"; this
  // says which 23 and in which direction, which is the difference between a number and a diagnosis.
  const perPatient = args.perPatient ? readPerPatient(args) : undefined;
  if (perPatient) {
    const sums: Record<string, number> = {};
    for (const row of Object.values(perPatient)) {
      for (const [cypressKey] of POPULATION_KEYS) sums[cypressKey] = (sums[cypressKey] ?? 0) + (row[cypressKey] ?? 0);
    }
    // Exactly what oracle contamination breaks: a re-run of ProductTestSetupJob doubles the aggregate
    // while leaving the per-patient rows untouched (spike §9 trap 3).
    const disagreeing = expected
      ? Object.keys(expected).filter((k) => (sums[k] ?? 0) !== expected[k])
      : [];
    out.push(
      "",
      "## Per-subject comparison",
      "",
      disagreeing.length === 0
        ? `- oracle self-check: per-patient rows sum to the aggregate expected results${expected ? "" : " (no aggregate supplied)"}`
        : `- **ORACLE INCONSISTENT**: per-patient rows do not sum to the aggregate for ${disagreeing.join(", ")}. ` +
          `That is the signature of a contaminated setup run — rebuild before trusting anything below.`,
    );

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
    out.push(`- subjects compared: **${compared}** of ${subjects.length}${unmatchedSubjects > 0 ? ` (**${unmatchedSubjects} unmatched by identifier**)` : ""}`);
    out.push(`- subjects agreeing on every population: **${compared - rows.length}**`, "");
    for (const [population, tally] of byPopulation) {
      out.push(`- \`${population}\`: **${tally.theyOnly}** subject(s) Cypress includes and we do not; **${tally.weOnly}** we include and Cypress does not`);
    }
    if (rows.length > 0) out.push("", `**${rows.length} differing subject(s):**`, ...rows.slice(0, 60));
  }

  if (injected) {
    const before = subjects.findIndex((s) => s.label === injection!.subjectLabel);
    const after = await evaluate(cypressPeriod, [injected]);
    out.push(
      "",
      "## Injection experiment",
      "",
      `Subject \`${injection!.subjectLabel}\`, ${injection!.resources.length} resource(s) added:`,
      "",
      "```text",
      `as imported   ${JSON.stringify(primary.membership[before]?.populations)}`,
      `+ injected    ${JSON.stringify(after.membership[0]?.populations)}`,
      "```",
    );
  }

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

/** The oracle snapshot's own record of this test, for the checks the harness makes about ITSELF. */
function readOracle(args: Args): { patients?: number } | undefined {
  if (!args.expected) return undefined;
  const raw = JSON.parse(readFileSync(args.expected, "utf8")) as {
    tests?: Record<string, { patients?: number }>;
  };
  const key = args.expectedKey ?? Object.keys(raw.tests ?? {})[0];
  return key ? raw.tests?.[key] : undefined;
}

/**
 * Cypress's per-patient populations, keyed by MBI (or a `dem:`-prefixed demographic fallback).
 *
 * REFUSES an unknown key rather than returning undefined. `--per-patient-key` exists to stop a silent
 * comparison against the wrong test, and a typo or a stale CMS version number would otherwise skip the
 * per-subject comparison AND the oracle-sum self-check while the command still printed a plausible
 * aggregate table and exited 0 (Codex, #387).
 */
function readPerPatient(args: Args): Record<string, Record<string, number>> {
  const raw = JSON.parse(readFileSync(args.perPatient!, "utf8")) as Record<string, Record<string, Record<string, number>>>;
  const rows = raw[args.perPatientKey!];
  if (!rows) {
    throw new Error(
      `--per-patient-key '${args.perPatientKey}' is not in ${args.perPatient} ` +
        `(it holds: ${Object.keys(raw).join(", ")})`,
    );
  }
  return rows;
}

/** Every expected population set this harness does NOT compare — named, never silently dropped. */
function uncomparedSets(args: Args): Array<{ name: string; counts: Record<string, number> }> {
  if (!args.expected) return [];
  const raw = JSON.parse(readFileSync(args.expected, "utf8")) as {
    tests?: Record<string, { expected?: Record<string, Record<string, number>> }>;
  };
  const key = args.expectedKey ?? Object.keys(raw.tests ?? {})[0];
  const sets = key ? raw.tests?.[key]?.expected : undefined;
  return Object.entries(sets ?? {})
    .filter(([name]) => name !== "PopulationSet_1")
    .map(([name, counts]) => ({ name, counts }));
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
