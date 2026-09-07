/**
 * `official-flip-gate` — the evidence a measure with NO authored counterpart is flipped on.
 *
 * `official-flip-snapshot` answers "how would the roster change?" by evaluating the same subjects
 * through the authored engine and the official artifact and diffing them. For cms2, cms130 and cms165
 * that question has no answer: there is no authored measure to be the BEFORE, so the snapshot's
 * comparison cannot run at all. This is its successor for those measures — it replaces the diff with
 * three independent readings, each of which can fail the flip on its own:
 *
 *   1. MADiE — the measure steward's own expected population vectors. The external ground truth, run
 *      through `runOfficialMeasure`, the same function CI's gate calls, so the two cannot drift.
 *   2. The roster — the official artifact over this deployment's real subjects, evaluated through
 *      `evaluateLikeTheRunPipeline` so the batch-then-single fallback the run pipeline uses is
 *      modelled rather than approximated (ADR-039: a shadow of the runtime, not a study of its own).
 *   3. effectivePeriod — whether the vendored artifact's declared vintage actually covers the period
 *      being measured. A 2026 artifact scoring a 2027 period is a stale-content finding (MM-1d).
 *
 * DESCRIPTIVE ONLY. The exit code is always 0 and the verdict is text: this reports what a flip would
 * do, and a human decides. Nothing here writes a measure into `WORKWELL_OFFICIAL_MEASURES` — that is a
 * workflow edit, made deliberately, per locked decision §4A.5 ("no known-unverified measure is routed
 * to the pilot").
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { officialMeasureExecutor, effectivePeriodWarning } from "../../wiring/official-executor-adapter.ts";
import { officialTerminologyExpander } from "../../wiring/official-terminology.ts";
import { loadOfficialArtifact } from "../../wiring/official-artifacts.ts";
import { evaluateLikeTheRunPipeline, type BatchAndSingle, type SnapshotSubject } from "./official-flip-snapshot.ts";
import { runOfficialMeasure, defaultOfficialCasesDeps } from "./official-cases.ts";
import { OFFICIAL_GATED_MEASURES, type OfficialMeasureId } from "../../standards/official-cases.ts";
import { composeDeploymentDirectory, type DeploymentProfile } from "../../config/deployment-profile.ts";
import { compositeBundleSource } from "../../wiring/subject-bundle-source.ts";
import { corpusBundleSource } from "../../wiring/corpus-bundle-source.ts";
import { corpusSeedFromEnv } from "../../engine/synthetic/corpus/corpus-directory.ts";
import { runChunkSize } from "../run-pipeline.ts";

/** Non-compliant statuses — the ones that put a subject on somebody's worklist. */
const ACTIONABLE = new Set(["OVERDUE", "DUE_SOON"]);

export interface FlipGateMadie {
  /** Cases whose population vector matched the steward's expectation, after the reference adjustment. */
  readonly pass: number;
  readonly fail: number;
  readonly total: number;
  /** Set when the deck could not be run at all — a skip is not a pass. */
  readonly unavailable?: string;
}

/**
 * Whose roster the reading describes. Attached to the JSON a flip PR carries, so "48 subjects in the
 * initial population" can be read as the fixture or as a slice of the 20,000-patient corpus rather
 * than guessed at.
 */
export interface RosterSource {
  readonly profile: string;
  /** Every evaluable subject the deployment's directory holds. */
  readonly directorySize: number;
  /** How many of them this gate actually evaluated (`--subjects` caps it). */
  readonly evaluated: number;
  /** The `WORKWELL_OFFICIAL_MEASURES` the roster was composed under — the deployment's list plus the measure under test. */
  readonly routedAs: string;
}

export interface FlipGateRoster {
  readonly subjects: number;
  readonly source?: RosterSource;
  /** Subjects the official artifact admitted to its initial population (ADR-043's signal) — rate 1's. */
  readonly inIpp: number;
  readonly denominator: number;
  /**
   * EVERY rate's initial population, denominator and numerator, in the artifact's group order. A
   * multi-rate measure (CMS137) has rates that genuinely differ, and a gate that read rate 1 alone
   * would pass an Engagement rate nobody reaches (ADR-074). One entry for a single-rate measure.
   */
  readonly rates: ReadonlyArray<{ readonly inIpp: number; readonly denominator: number; readonly numerator: number }>;
  readonly distribution: Record<string, number>;
  /** Subjects the executor returned nothing for, even after the per-subject fallback. */
  readonly evaluationErrors: number;
  readonly actionable: number;
}

export interface FlipGateReport {
  readonly measureId: string;
  readonly evaluationDate: string;
  readonly madie: FlipGateMadie;
  readonly roster: FlipGateRoster;
  readonly effectivePeriod: { readonly covered: boolean; readonly warning: string | null };
  readonly verdictText: string;
}

export interface GateDeps {
  readonly executor?: BatchAndSingle;
  readonly madie?: (measureId: OfficialMeasureId) => Promise<FlipGateMadie>;
  readonly loadArtifact?: (catalogId: string) => ReturnType<typeof loadOfficialArtifact>;
  readonly contentDir?: string;
  /** Recorded on the report verbatim; `rosterSubjectsFor` produces it beside the subjects. */
  readonly rosterSource?: RosterSource;
  /** Subjects per executor batch; defaults to the run pipeline's own `WORKWELL_RUN_CHUNK_SIZE` (500). */
  readonly chunkSize?: number;
}

/**
 * The deployment's OWN roster, composed the way the run pipeline composes it — `composeDeploymentDirectory`
 * for the subjects and `compositeBundleSource` for their records — with the measure under test routed
 * HYPOTHETICALLY: the composite refuses a measure the env does not route, and the whole point of the gate
 * is that the measure is not routed yet. So the env it is composed under is the deployment's list plus
 * this measure, which is exactly the configuration the flip would create.
 *
 * Until MM-1 U3 the CLI built its subjects from the 48-row occupational fixture filtered to the maui
 * tenant through the official-only fixture bundles. U2 made Maui's roster the generated corpus, so the
 * gate was measuring a roster the deployment no longer ran — a corpus shape the artifact could not read
 * would have passed it (the class of failure `corpus-official-population.test.ts` exists for).
 *
 * `limit` caps how many subjects are materialised: every bundle is built up front (evaluation then
 * runs in the pipeline's chunks inside `gateMeasure`), so the cap is the memory and time control on a
 * 20,000-patient directory.
 */
export function rosterSubjectsFor(
  measureId: string,
  evaluationDate: string,
  env: Record<string, unknown>,
  profile: DeploymentProfile,
  opts: { readonly limit?: number } = {},
): { subjects: SnapshotSubject[]; source: RosterSource } {
  // Refused HERE, not left to the bundle source: Maui's corpus source deliberately does not gate
  // `bundleForSubject` (it has no measure id to gate on), so the gate would otherwise build a whole
  // corpus for a measure the profile cannot run and print a report about it; and on a profile with no
  // fixture shape for the measure the old path handed the executor `bundle: undefined` for every
  // subject and died inside it. A usage error names the measure and the profile instead.
  if (!(profile.runnableMeasureIds as readonly string[]).includes(measureId)) {
    throw new FlipGateUsageError(
      `${measureId} is not in the ${profile.id} profile's measure set (${profile.runnableMeasureIds.join(", ")}); ` +
        `set WORKWELL_INSTANCE to the deployment that runs it`,
    );
  }
  const routed = String(env.WORKWELL_OFFICIAL_MEASURES ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (!routed.includes(measureId)) routed.push(measureId);
  const routedAs = routed.join(",");
  const hypothetical: Record<string, unknown> = { ...env, WORKWELL_OFFICIAL_MEASURES: routedAs };

  // The directory and the corpus source are built from the SAME env, so they agree on who a subject
  // is whatever process.env says — the composite's own default reads the deployment's seed, which is
  // the right answer for a runtime caller and not for a gate that composed its own directory.
  const directory = composeDeploymentDirectory(profile, hypothetical);
  const source = compositeBundleSource(hypothetical, { corpus: corpusBundleSource(corpusSeedFromEnv(hypothetical)) }, profile);
  const employees = directory.EVALUABLE_EMPLOYEES;
  const taken = opts.limit === undefined ? employees : employees.slice(0, opts.limit);
  // The pipeline prefers the subject's whole record where the source provides one (spec §4) and
  // otherwise builds the measure's own bundle around the seeded target — mirrored here in that order.
  const subjects: SnapshotSubject[] = taken.map((employee) => ({
    subjectId: employee.externalId,
    bundle: source.bundleForSubject
      ? source.bundleForSubject(employee, evaluationDate)
      : source.bundleFor(
          employee,
          measureId,
          source.targetFor(employees, measureId, employee.externalId) ?? "COMPLIANT",
          evaluationDate,
        ),
  }));
  return {
    subjects,
    source: { profile: profile.id, directorySize: employees.length, evaluated: subjects.length, routedAs },
  };
}

const tally = (values: Iterable<string>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

/** The measurement period an eCQM is scored over: the calendar year the evaluation date falls in (U1 T4). */
export function calendarPeriodFor(evaluationDate: string): { start: string; end: string } {
  const year = evaluationDate.slice(0, 4);
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/**
 * Run the measure's MADiE deck through the SAME function CI's gate uses.
 *
 * A deck this checkout does not have is an UNAVAILABLE reading, not a crash. `.official-content` is a
 * SPARSE clone whose cone is fixed at first fetch, so a checkout that predates a measure's onboarding
 * serves no deck for it while `git log` shows the same pinned commit — an absence indistinguishable
 * from upstream not shipping one. (That is not hypothetical: it is what made cms130/cms165 look
 * deck-less on 2026-09-05 until `fetch-official-cases.ps1` was re-run.) Dying here would make the tool
 * useless precisely where it is needed, and would report nothing about the other two readings, which
 * still work. Re-run the fetch script before believing a deck is genuinely absent.
 */
async function defaultMadie(measureId: OfficialMeasureId, contentDir: string): Promise<FlipGateMadie> {
  const deps = defaultOfficialCasesDeps();
  let outcome;
  try {
    outcome = await runOfficialMeasure(measureId, contentDir, deps, { allowMissingTerminology: true });
  } catch (error) {
    return {
      pass: 0,
      fail: 0,
      total: 0,
      unavailable:
        `the deck could not be loaded from ${contentDir} — ${error instanceof Error ? error.message : String(error)}. ` +
        "A deck that did not run is NOT a pass: run this where the content checkout carries the measure " +
        "(the credentialed vendor-official-measure.yml workflow) before reading it as evidence.",
    };
  }
  if (outcome.kind === "skipped") {
    return {
      pass: 0,
      fail: 0,
      total: 0,
      unavailable:
        `this context cannot resolve ${outcome.oids.join(", ")}, so the deck did not run. A skip is ` +
        "NOT a pass — re-run where the terminology resolves before reading this as evidence.",
    };
  }
  const { summary } = outcome.run;
  const pass = summary.expectedAgreements + summary.referenceAgreements;
  return { pass, fail: summary.total - pass, total: summary.total };
}

/**
 * The three readings for one measure. Pure with respect to the world except through `deps`, so the
 * test drives it with a stub executor and a stub deck rather than a live artifact.
 */
export async function gateMeasure(
  measureId: OfficialMeasureId,
  subjects: readonly SnapshotSubject[],
  evaluationDate: string,
  deps: GateDeps = {},
): Promise<FlipGateReport> {
  const loadArtifact = deps.loadArtifact ?? loadOfficialArtifact;
  const executor =
    deps.executor ?? officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });

  // In the run pipeline's OWN chunks (ADR-075): one 20,000-subject batch is a different working set
  // and a different failure surface from twenty 500s, and the whole point of the roster reading is to
  // be a shadow of the run rather than a study of its own. A chunk the executor refuses outright ends
  // the reading and is reported; a subject it drops is an evaluation error, whichever chunk it was in.
  const chunkSize = Math.max(1, deps.chunkSize ?? runChunkSize(process.env as Record<string, unknown>));
  const outcomes = new Map<string, { outcome: string; evidence?: unknown }>();
  let batchError: string | undefined;
  for (let start = 0; start < subjects.length; start += chunkSize) {
    const chunk = subjects.slice(start, start + chunkSize);
    const batch = chunk.map(({ subjectId, bundle }) => ({ subjectId, patientBundle: bundle }));
    try {
      const part = (await evaluateLikeTheRunPipeline(executor, measureId, chunk, batch as never, evaluationDate)) as Map<
        string,
        { outcome: string; evidence?: unknown }
      >;
      for (const [subjectId, outcome] of part) outcomes.set(subjectId, outcome);
    } catch (error) {
      batchError = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const statuses = [...outcomes.values()].map((o) => o.outcome);
  // `populationResults` is fqm-execution's ARRAY of {populationType, result}, verbatim — NOT a keyed
  // record. Reading it as a record returns undefined for every key, which makes inIpp
  // unconditionally 0 and fires the ADR-043 "nobody is in the initial population" blocker on every
  // measure regardless of what the artifact did — the gate would always say DO NOT FLIP, for a reason
  // indistinguishable from the real thing. Shape pinned by OfficialEvidence in
  // packages/measure-engine/src/evaluate-measure.ts.
  type Populations = ReadonlyArray<{ populationType?: string; result?: boolean }>;
  // EVERY rate: `official.rates` where the measure declares more than one, else the single
  // `populationResults` (ADR-074). Reading rate 1 alone would let CMS137's Engagement rate be empty
  // across a whole deployment while the gate reported a healthy population.
  const ratesOf = (o: unknown): Populations[] => {
    const official = (o as { evidence?: { official?: { populationResults?: Populations; rates?: Populations[] } } })?.evidence?.official;
    if (Array.isArray(official?.rates) && official.rates.length > 1) return official.rates;
    return Array.isArray(official?.populationResults) ? [official.populationResults] : [];
  };
  const inPopulation = (populations: Populations, key: string): boolean =>
    populations.some((p) => p?.populationType === key && p?.result === true);
  const rateCount = Math.max(1, ...[...outcomes.values()].map((o) => ratesOf(o).length));
  const rates = Array.from({ length: rateCount }, (_, index) => ({
    inIpp: [...outcomes.values()].filter((o) => inPopulation(ratesOf(o)[index] ?? [], "initial-population")).length,
    denominator: [...outcomes.values()].filter((o) => inPopulation(ratesOf(o)[index] ?? [], "denominator")).length,
    numerator: [...outcomes.values()].filter((o) => inPopulation(ratesOf(o)[index] ?? [], "numerator")).length,
  }));
  const roster: FlipGateRoster = {
    subjects: subjects.length,
    ...(deps.rosterSource ? { source: deps.rosterSource } : {}),
    inIpp: rates[0]!.inIpp,
    denominator: rates[0]!.denominator,
    rates,
    distribution: tally(statuses),
    evaluationErrors: subjects.length - outcomes.size,
    actionable: statuses.filter((s) => ACTIONABLE.has(s)).length,
  };

  const madie = deps.madie
    ? await deps.madie(measureId)
    : await defaultMadie(measureId, deps.contentDir ?? resolve(process.cwd(), ".official-content"));

  const artifact = loadArtifact(measureId);
  const period = calendarPeriodFor(evaluationDate);
  const warning = artifact ? effectivePeriodWarning(artifact, period) : null;

  return {
    measureId,
    evaluationDate,
    madie,
    roster,
    effectivePeriod: { covered: warning === null, warning },
    verdictText: verdictFor({ measureId, madie, roster, batchError, warning }),
  };
}

/**
 * The verdict is prose, and it names every reason rather than reducing to a boolean — a gate that says
 * only DO-NOT-FLIP tells the reader nothing about which of the three readings failed.
 */
function verdictFor(input: {
  measureId: string;
  madie: FlipGateMadie;
  roster: FlipGateRoster;
  batchError?: string;
  warning: string | null;
}): string {
  const blockers: string[] = [];
  // A refused batch is ONE finding, and it ends the roster reading. The subjects it never reached are
  // not "out of the initial population" and were never offered the per-subject fallback, so the ADR-043
  // sentence and the fallback sentence below would send an operator to check bundle shapes for what
  // was an executor crash (review finding). They are reported as never evaluated instead.
  if (input.batchError) {
    blockers.push(`the executor refused the batch outright: ${input.batchError}`);
    if (input.roster.evaluationErrors > 0) blockers.push(`${input.roster.evaluationErrors} subject(s) were never evaluated because of it`);
  }
  if (input.madie.unavailable) blockers.push(`the MADiE deck did not run — ${input.madie.unavailable}`);
  else if (input.madie.fail > 0) blockers.push(`${input.madie.fail} of ${input.madie.total} MADiE cases disagree with the steward's expected vector`);
  // ADR-043: a whole roster out of the initial population is SURFACED, never refused mid-run — but it
  // is exactly the signal that a flip would silently empty somebody's worklist.
  if (!input.batchError && input.roster.subjects > 0 && input.roster.inIpp === 0) {
    blockers.push(
      `NOBODY in this deployment's ${input.roster.subjects} subjects is in the official initial ` +
        "population (ADR-043). Flipping would report every subject as out-of-population rather than " +
        "as non-compliant — check the bundle shape against the artifact's own retrieves before flipping",
    );
  }
  // A rate nobody reaches is the multi-rate form of the same signal: a deployment where every subject is
  // in Engagement's denominator and none in its numerator would flip with a plausible Initiation rate
  // and a silent 0% beside it.
  for (const [index, rate] of input.roster.rates.entries()) {
    if (input.roster.rates.length > 1 && rate.denominator > 0 && rate.numerator === 0) {
      blockers.push(
        `rate ${index + 1}: ${rate.denominator} subjects in its denominator and NONE in its numerator — ` +
          "the data shape may not reach this rate at all; check the corresponding retrieves before flipping",
      );
    }
  }
  if (!input.batchError && input.roster.evaluationErrors > 0) {
    blockers.push(`${input.roster.evaluationErrors} subject(s) produced no outcome even after the per-subject fallback`);
  }
  if (input.warning) blockers.push(input.warning);

  if (blockers.length === 0) {
    return (
      `${input.measureId}: the three readings agree — ${input.madie.pass}/${input.madie.total} MADiE cases, ` +
      `${input.roster.inIpp}/${input.roster.subjects} subjects in the initial population ` +
      `(${input.roster.actionable} actionable), and the artifact's effectivePeriod covers the measured year. ` +
      "This is evidence FOR the flip; the flip itself is a workflow edit a human still makes."
    );
  }
  return `${input.measureId}: DO NOT FLIP YET — ${blockers.length} finding(s):\n` +
    blockers.map((b, i) => `  ${i + 1}. ${b}`).join("\n");
}

/** The human-readable report. */
export function renderGate(report: FlipGateReport): string {
  const lines = [
    `# official-flip-gate — ${report.measureId}`,
    "",
    `Evaluation date: ${report.evaluationDate}  (measurement period ${calendarPeriodFor(report.evaluationDate).start}..${calendarPeriodFor(report.evaluationDate).end})`,
    "",
    "## 1. MADiE — the measure steward's own expected vectors",
    report.madie.unavailable
      ? `  NOT RUN. ${report.madie.unavailable}`
      : `  ${report.madie.pass}/${report.madie.total} agree; ${report.madie.fail} disagree.`,
    "",
    "## 2. The roster — the official artifact over this deployment's subjects",
    ...(report.roster.source
      ? [
          `  roster: profile=${report.roster.source.profile} directory=${report.roster.source.directorySize} ` +
            `evaluated=${report.roster.source.evaluated} (routed as WORKWELL_OFFICIAL_MEASURES=${report.roster.source.routedAs})`,
        ]
      : []),
    `  subjects=${report.roster.subjects} inInitialPopulation=${report.roster.inIpp} denominator=${report.roster.denominator}`,
    ...(report.roster.rates.length > 1
      ? report.roster.rates.map((r, i) => `  rate ${i + 1}: inInitialPopulation=${r.inIpp} denominator=${r.denominator} numerator=${r.numerator}`)
      : []),
    `  actionable=${report.roster.actionable} evaluationErrors=${report.roster.evaluationErrors}`,
    `  distribution: ${JSON.stringify(report.roster.distribution)}`,
    "",
    "## 3. effectivePeriod",
    report.effectivePeriod.covered
      ? "  The vendored artifact's declared effectivePeriod covers the measured period."
      : `  ${report.effectivePeriod.warning}`,
    "",
    "## Verdict",
    report.verdictText,
    "",
  ];
  return lines.join("\n");
}

/** Where the machine-readable summary lands, for attaching to the flip PR. */
export function writeGateJson(cwd: string, report: FlipGateReport): string {
  const path = resolve(cwd, ".flip-gate", `${report.measureId}-${report.evaluationDate}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export interface FlipGateArgs {
  readonly measure: OfficialMeasureId;
  readonly evaluationDate: string;
  readonly contentDir?: string;
  /** `--subjects N` caps the roster reading; `--subjects all` lifts the CLI's default cap. Absent = not given. */
  readonly subjects?: number | "all";
}

export class FlipGateUsageError extends Error {}

/** `--evaluation-date` defaults to today in UTC, so an unqualified run is still reproducible in its report. */
export function parseArgs(argv: readonly string[], today: () => Date = () => new Date()): FlipGateArgs {
  let measure: string | undefined;
  let evaluationDate: string | undefined;
  let contentDir: string | undefined;
  let subjects: number | "all" | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--measure") measure = argv[++i];
    else if (arg === "--evaluation-date") evaluationDate = argv[++i];
    else if (arg === "--content-dir") contentDir = argv[++i];
    else if (arg === "--subjects") {
      const raw = argv[++i];
      if (raw === "all") subjects = "all";
      else {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new FlipGateUsageError(`--subjects must be a positive integer or "all", got ${raw}`);
        }
        subjects = parsed;
      }
    } else throw new FlipGateUsageError(`unknown argument: ${arg}`);
  }
  if (!measure) throw new FlipGateUsageError("--measure is required");
  // Validate the id rather than casting it. Unchecked, `--measure cms999` sails through parseArgs and
  // dies much later inside buildOfficialOnlyBundle (whose switch has no default and returns undefined),
  // so a typo surfaces as an opaque crash instead of the usage error and exit 2 this CLI defines.
  if (!OFFICIAL_GATED_MEASURES.includes(measure as OfficialMeasureId)) {
    throw new FlipGateUsageError(
      `--measure must be one of ${OFFICIAL_GATED_MEASURES.join(", ")}, got ${measure}`,
    );
  }
  const date = evaluationDate ?? today().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new FlipGateUsageError(`--evaluation-date must be YYYY-MM-DD, got ${date}`);
  // The regex only proves the SHAPE. `2027-99-99` matches it, then becomes an Invalid Date whose
  // toISOString() throws a RangeError deep in the bundle builder. Round-tripping is what proves the
  // date exists — it also rejects 2027-02-30, which no regex can.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new FlipGateUsageError(`--evaluation-date is not a real date: ${date}`);
  }
  return { measure: measure as OfficialMeasureId, evaluationDate: date, contentDir, ...(subjects !== undefined ? { subjects } : {}) };
}
