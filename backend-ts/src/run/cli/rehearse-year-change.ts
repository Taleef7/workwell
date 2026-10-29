/**
 * CLI: rehearse 1 January (#854). Runs the nightly exactly as the scheduler does (`runNightlyRecompute`),
 * evaluated as of `--evaluation-date`, against the Postgres in DATABASE_URL, then measures and checks it.
 * Run it on a COPY, twice: as of the old year's last day (2026-12-31), then the new year's first (2027-01-01).
 *
 *   pnpm rehearse:year-change --evaluation-date 2027-01-01 --confirm-host <DATABASE_URL's host> [--out <file.json>]
 *
 * It writes what a real nightly writes: runs, outcomes, cases and audit events. As of 2027-01-01 it closes
 * every open 2026 case of an evaluated patient as rolled over. Hence two refusals: `--confirm-host` must repeat
 * DATABASE_URL's host, so a URL left in the shell for a live stack is refused rather than rolled over; and a
 * configured WebChart tenant is refused, because the rehearsal evaluates the synthetic corpus and must not
 * spend the tenant's daily call limit. Alerts go to the console only.
 *
 * This module is side-effect-free and importable by tests; `rehearse-year-change-bin.ts` is the runnable entry.
 */
import { writeFileSync } from "node:fs";
import { nightlyDepsForEnv, runNightlyRecompute, type SchedulerTickDeps } from "../../admin/scheduler.ts";
import { ACTIVE_CASE_STATUSES } from "../../case/case-logic.ts";
import { RUNNABLE_MEASURE_IDS } from "../../config/deployment-profile.ts";
import { resolveAlertChannels } from "../alert-channel.ts";
import { isWebChartConfigured } from "../../engine/ingress/data-source.ts";
import { scoringLogicOf } from "../../measure/measure-identity.ts";
import { bucketPeriodForMeasure } from "../compliance-period.ts";

export const USAGE =
  "Usage: pnpm rehearse:year-change --evaluation-date YYYY-MM-DD --confirm-host <DATABASE_URL's host> [--out <file.json>]";

export class RehearsalUsageError extends Error {}

export interface RehearsalArgs {
  evaluationDate: string;
  confirmHost: string;
  out: string | null;
}

export function parseArgs(argv: readonly string[]): RehearsalArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!["--evaluation-date", "--confirm-host", "--out"].includes(flag)) throw new RehearsalUsageError(`unknown argument "${flag}"`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new RehearsalUsageError(`${flag} needs a value`);
    values.set(flag, value);
  }
  const evaluationDate = values.get("--evaluation-date");
  // Round-tripped, because `Date.parse` rolls an impossible day over (2027-02-30 reads as 2 March).
  const parsed = new Date(`${evaluationDate}T00:00:00Z`);
  if (!evaluationDate || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== evaluationDate) {
    throw new RehearsalUsageError("--evaluation-date YYYY-MM-DD (a real calendar date) is required");
  }
  const confirmHost = values.get("--confirm-host");
  if (!confirmHost) throw new RehearsalUsageError("--confirm-host is required");
  return { evaluationDate, confirmHost, out: values.get("--out") ?? null };
}

/** Why this env may not be rehearsed on, or null. */
export function refusalFor(env: Record<string, unknown>, confirmHost: string): string | null {
  const url = typeof env.DATABASE_URL === "string" ? env.DATABASE_URL.trim() : "";
  if (!url) return "DATABASE_URL is not set: the rehearsal runs against a Postgres copy, never the in-memory floor.";
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "DATABASE_URL is not a URL.";
  }
  if (host !== confirmHost) return `--confirm-host "${confirmHost}" does not match DATABASE_URL's host "${host}".`;
  if (isWebChartConfigured(env)) return "A WebChart tenant is configured: unset WORKWELL_WEBCHART_* so the rehearsal evaluates the synthetic corpus.";
  return null;
}

export interface MeasureSummary {
  measureId: string;
  period: string;
  /** Open cases in the run's cycle, and in every other (the rollover closes the earlier ones). */
  activeBefore: { current: number; otherCycles: number };
  activeAfter: { current: number; otherCycles: number };
  /** Each logic that scored the run's rows, with its row count; "error" for an errored row. */
  scoredBy: Record<string, number>;
}

export interface RehearsalSummary {
  evaluationDate: string;
  runId: string;
  status: string | null;
  runMs: number | null;
  /** The whole nightly: the run, retention (inert unless configured) and the dashboard warm. */
  nightlyMs: number;
  /** From the run's completion to the end of the nightly. */
  afterRunMs: number | null;
  peakRssMb: number;
  evaluated: number | null;
  failures: number | null;
  rollover: { closed: number; failed: number; auditGaps: number; unreadMeasures: string[]; ms: number } | null;
  rolledOverAudited: number;
  auditEvents: Record<string, number>;
  dataSufficiency: "not measured (no live WebChart data)" | { dataInsufficient: unknown[] };
  measures: MeasureSummary[];
  warnings: string[];
  checks: { check: string; ok: boolean; detail: string }[];
}

async function activeCount(deps: SchedulerTickDeps, measureId: string, period?: string): Promise<number> {
  const page = await deps.stores.cases.listCasesPage({ measureId, statuses: [...ACTIVE_CASE_STATUSES], period }, { limit: 1, offset: 0 });
  return page.total;
}

async function activeCounts(deps: SchedulerTickDeps, measureIds: readonly string[], evaluationDate: string) {
  const counts = new Map<string, { current: number; otherCycles: number }>();
  for (const measureId of measureIds) {
    const current = await activeCount(deps, measureId, bucketPeriodForMeasure(measureId, evaluationDate));
    counts.set(measureId, { current, otherCycles: (await activeCount(deps, measureId)) - current });
  }
  return counts;
}

/** The nightly as of `evaluationDate`, measured. `measureIds` are the measures the nightly runs (the deployment's runnable set). */
export async function rehearse(
  deps: SchedulerTickDeps,
  evaluationDate: string,
  measureIds: readonly string[],
  sampleEveryMs = 1000,
): Promise<RehearsalSummary> {
  const before = await activeCounts(deps, measureIds, evaluationDate);

  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, sampleEveryMs);
  sampler.unref();
  const startedMs = Date.now();
  let runId: string;
  try {
    runId = await runNightlyRecompute({ ...deps, evaluationDate });
  } finally {
    clearInterval(sampler);
  }
  const endedMs = Date.now();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const run = await deps.stores.runs.getRun(runId);
  const audits = await deps.stores.events.auditEventsByRun(runId);
  const completed = audits.find((a) => a.eventType === "RUN_COMPLETED")?.payload ?? {};
  const auditEvents: Record<string, number> = {};
  for (const a of audits) auditEvents[a.eventType] = (auditEvents[a.eventType] ?? 0) + 1;
  const rolledOverAudited = audits.filter((a) => a.eventType === "CASE_RESOLVED" && a.payload.reason === "CYCLE_ROLLED_OVER").length;
  const executed = Array.isArray(completed.measuresExecuted) ? (completed.measuresExecuted as string[]) : [...measureIds];
  const after = await activeCounts(deps, executed, evaluationDate);

  const measures: MeasureSummary[] = [];
  for (const measureId of executed) {
    const scoredBy: Record<string, number> = {};
    for (const row of await deps.stores.outcomes.listOutcomeSubjectMembershipsForRun(runId, measureId)) {
      const logic = scoringLogicOf(row.evidence);
      const key =
        (row.evidence as { evaluationError?: unknown } | null)?.evaluationError !== undefined ? "error"
        : logic === null ? "authored"
        : logic.kind === "workwell-translation" ? `${logic.label} (${logic.version})`
        : `${logic.ecqmId} v${logic.version}`;
      scoredBy[key] = (scoredBy[key] ?? 0) + 1;
    }
    measures.push({
      measureId,
      period: bucketPeriodForMeasure(measureId, evaluationDate),
      activeBefore: before.get(measureId) ?? { current: 0, otherCycles: 0 },
      activeAfter: after.get(measureId)!,
      scoredBy,
    });
  }

  const rollover = (completed.rollover as RehearsalSummary["rollover"] | undefined) ?? null;
  const closedOther = measures.reduce((n, m) => n + (m.activeBefore.otherCycles - m.activeAfter.otherCycles), 0);
  const failures = typeof completed.failures === "number" ? completed.failures : null;
  const logs = await deps.stores.runs.listLogs(runId);
  const runMs = run?.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null;

  const checks: RehearsalSummary["checks"] = [
    { check: "the run completed", ok: run?.status === "COMPLETED", detail: String(run?.status) },
    { check: "no evaluation failed", ok: failures === 0, detail: `${failures} failure(s)` },
    {
      check: "every measure was scored by one logic, with no errored row",
      ok: measures.every((m) => Object.keys(m.scoredBy).length === 1 && !("error" in m.scoredBy)),
      detail: measures.map((m) => `${m.measureId}: ${Object.keys(m.scoredBy).join(" + ") || "no rows"}`).join("; "),
    },
    {
      check: "every rolled-over case left its earlier cycle and has its audit event",
      ok:
        (rollover?.closed ?? 0) === closedOther &&
        closedOther === rolledOverAudited &&
        (rollover?.failed ?? 0) === 0 &&
        (rollover?.unreadMeasures.length ?? 0) === 0,
      detail:
        `run closed ${rollover?.closed ?? 0}, open cases in other cycles fell by ${closedOther}, ` +
        `${rolledOverAudited} CYCLE_ROLLED_OVER audit event(s)` +
        (rollover?.unreadMeasures.length ? `, unread: ${rollover.unreadMeasures.join(", ")}` : ""),
    },
    {
      check: "the data-sufficiency check stayed silent",
      ok: !Array.isArray(completed.dataInsufficient) || completed.dataInsufficient.length === 0,
      detail: completed.dataSufficiency === undefined ? "not measured (no live WebChart data)" : JSON.stringify(completed.dataInsufficient),
    },
  ];

  return {
    evaluationDate,
    runId,
    status: run?.status ?? null,
    runMs,
    nightlyMs: endedMs - startedMs,
    afterRunMs: run?.completedAt ? endedMs - Date.parse(run.completedAt) : null,
    peakRssMb: Math.round(peakRss / 1024 / 1024),
    evaluated: typeof completed.totalEvaluated === "number" ? completed.totalEvaluated : null,
    failures,
    rollover,
    rolledOverAudited,
    auditEvents,
    dataSufficiency:
      completed.dataSufficiency === undefined
        ? "not measured (no live WebChart data)"
        : { dataInsufficient: (completed.dataInsufficient as unknown[] | undefined) ?? [] },
    measures,
    warnings: logs.filter((l) => l.level !== "INFO").map((l) => `${l.level} ${l.message}`),
    checks,
  };
}

const seconds = (ms: number | null): string => (ms === null ? "?" : `${(ms / 1000).toFixed(1)} s`);

export function render(summary: RehearsalSummary): string {
  const lines = [
    `Rehearsal as of ${summary.evaluationDate}: run ${summary.runId} ${summary.status}`,
    `  run ${seconds(summary.runMs)}, nightly ${seconds(summary.nightlyMs)} (after the run: ${seconds(summary.afterRunMs)}), peak RSS ${summary.peakRssMb} MB`,
    `  evaluated ${summary.evaluated}, failures ${summary.failures}`,
    `  rollover: ${summary.rollover ? `${summary.rollover.closed} closed in ${seconds(summary.rollover.ms)}, ${summary.rollover.failed} failed, ${summary.rollover.auditGaps} audit gap(s)` : "nothing to close"}`,
    `  audit events: ${Object.entries(summary.auditEvents).map(([t, n]) => `${t} ${n}`).join(", ")}`,
    "  measure   period      open in it (before -> after)   open in other cycles (before -> after)   scored by",
    ...summary.measures.map(
      (m) =>
        `  ${m.measureId.padEnd(9)} ${m.period}  ${String(m.activeBefore.current).padStart(6)} -> ${String(m.activeAfter.current).padEnd(22)}` +
        ` ${String(m.activeBefore.otherCycles).padStart(6)} -> ${String(m.activeAfter.otherCycles).padEnd(31)}` +
        ` ${Object.entries(m.scoredBy).map(([k, n]) => `${k} x${n}`).join(", ")}`,
    ),
    ...summary.checks.map((c) => `  [${c.ok ? "ok" : "FAIL"}] ${c.check}: ${c.detail}`),
    ...summary.warnings.map((w) => `  ${w}`),
  ];
  return lines.join("\n");
}

/** Exit codes: 0 every check passed, 1 a check failed, 2 a usage error or a refused environment. */
export async function main(argv: readonly string[], env: Record<string, unknown> = process.env): Promise<number> {
  let args: RehearsalArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const refusal = refusalFor(env, args.confirmHost);
  if (refusal) {
    console.error(`Refused: ${refusal}`);
    return 2;
  }
  const deps = await nightlyDepsForEnv(env as Parameters<typeof nightlyDepsForEnv>[0], resolveAlertChannels({}));
  const summary = await rehearse(deps, args.evaluationDate, RUNNABLE_MEASURE_IDS);
  console.log(render(summary));
  if (args.out) writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  return summary.checks.every((c) => c.ok) ? 0 : 1;
}
