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
import type { OfficialMeasureId } from "../../standards/official-cases.ts";

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

export interface FlipGateRoster {
  readonly subjects: number;
  /** Subjects the official artifact admitted to its initial population (ADR-043's signal). */
  readonly inIpp: number;
  readonly denominator: number;
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
 * A deck this checkout does not have is an UNAVAILABLE reading, not a crash. cms130 and cms165 are
 * exactly that case today — the pinned content checkout ships no `input/tests/measure/` for either,
 * which is why neither could be vendored into the tree — and they are the two measures MM-1c most
 * needs this gate for. Dying here would make the tool useless precisely where it is needed, and worse,
 * it would report nothing about the other two readings, which do work.
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

  const batch = subjects.map(({ subjectId, bundle }) => ({ subjectId, patientBundle: bundle }));
  let outcomes = new Map<string, { outcome: string; evidence?: unknown }>();
  let batchError: string | undefined;
  try {
    outcomes = (await evaluateLikeTheRunPipeline(
      executor,
      measureId,
      subjects,
      batch as never,
      evaluationDate,
    )) as never;
  } catch (error) {
    batchError = error instanceof Error ? error.message : String(error);
  }

  const statuses = [...outcomes.values()].map((o) => o.outcome);
  const membership = (o: unknown, key: string): boolean => {
    const populations = (o as { evidence?: { official?: { populationResults?: Record<string, unknown> } } })
      ?.evidence?.official?.populationResults;
    return Boolean(populations && Number(populations[key] ?? 0) > 0);
  };
  const roster: FlipGateRoster = {
    subjects: subjects.length,
    inIpp: [...outcomes.values()].filter((o) => membership(o, "initial-population")).length,
    denominator: [...outcomes.values()].filter((o) => membership(o, "denominator")).length,
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
  if (input.batchError) blockers.push(`the executor refused the batch outright: ${input.batchError}`);
  if (input.madie.unavailable) blockers.push(`the MADiE deck did not run — ${input.madie.unavailable}`);
  else if (input.madie.fail > 0) blockers.push(`${input.madie.fail} of ${input.madie.total} MADiE cases disagree with the steward's expected vector`);
  // ADR-043: a whole roster out of the initial population is SURFACED, never refused mid-run — but it
  // is exactly the signal that a flip would silently empty somebody's worklist.
  if (input.roster.subjects > 0 && input.roster.inIpp === 0) {
    blockers.push(
      `NOBODY in this deployment's ${input.roster.subjects} subjects is in the official initial ` +
        "population (ADR-043). Flipping would report every subject as out-of-population rather than " +
        "as non-compliant — check the bundle shape against the artifact's own retrieves before flipping",
    );
  }
  if (input.roster.evaluationErrors > 0) {
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
    `  subjects=${report.roster.subjects} inInitialPopulation=${report.roster.inIpp} denominator=${report.roster.denominator}`,
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
}

export class FlipGateUsageError extends Error {}

/** `--evaluation-date` defaults to today in UTC, so an unqualified run is still reproducible in its report. */
export function parseArgs(argv: readonly string[], today: () => Date = () => new Date()): FlipGateArgs {
  let measure: string | undefined;
  let evaluationDate: string | undefined;
  let contentDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--measure") measure = argv[++i];
    else if (arg === "--evaluation-date") evaluationDate = argv[++i];
    else if (arg === "--content-dir") contentDir = argv[++i];
    else throw new FlipGateUsageError(`unknown argument: ${arg}`);
  }
  if (!measure) throw new FlipGateUsageError("--measure is required");
  const date = evaluationDate ?? today().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new FlipGateUsageError(`--evaluation-date must be YYYY-MM-DD, got ${date}`);
  return { measure: measure as OfficialMeasureId, evaluationDate: date, contentDir };
}
