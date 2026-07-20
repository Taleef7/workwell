/**
 * compliance.ts — the CQL→SQL demo compliance API (#292 / ADR-034; Doug's "is this patient
 * compliant for this measure, for this date range?").
 *
 * Loads the COMMITTED, reviewed SQL artifacts backend-ts generates (`sql/{measureId}.sql`,
 * `pnpm generate:sql` — never SQL assembled at request time), splits them on their
 * `-- @statement <name>` markers, and executes with bound `?` parameters. Read-only; demo-grade;
 * the CQL engine remains the sole compliance authority (ADR-008) — these results serve only this
 * API and the ADR-025 parity harness that gates them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface MeasureSql {
  measureId: string;
  meta: { windowDays?: number; dueSoonDays?: number; gracePeriodDays?: number };
  statements: Record<string, string>; // name (per-patient | single-patient | cohort) → SQL
}

const SQL_DIR = fileURLToPath(new URL("../sql", import.meta.url));

/** Parse one committed artifact: provenance header meta + `-- @statement` sections. */
export function parseSqlFile(measureId: string, content: string): MeasureSql {
  const meta: MeasureSql["meta"] = {};
  const metaMatch = /windowDays=(\d+), dueSoonDays=(\d+), gracePeriodDays=(\d+)/.exec(content);
  if (metaMatch) {
    meta.windowDays = Number(metaMatch[1]);
    meta.dueSoonDays = Number(metaMatch[2]);
    meta.gracePeriodDays = Number(metaMatch[3]);
  }
  const statements: Record<string, string> = {};
  const parts = content.split(/^-- @statement +([a-z-]+)[^\n]*$/m);
  // parts = [preamble, name1, body1, name2, body2, …]
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const name = parts[i]!.trim();
    const body = parts[i + 1]!.trim();
    if (name && body) statements[name] = body;
  }
  if (!statements["per-patient"] || !statements["single-patient"] || !statements["cohort"]) {
    throw new Error(`sql/${measureId}.sql is missing a required @statement section`);
  }
  return { measureId, meta, statements };
}

/** Load every committed measure artifact once at boot. */
export function loadMeasureSql(dir: string = SQL_DIR): Map<string, MeasureSql> {
  const out = new Map<string, MeasureSql>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    const measureId = file.slice(0, -4);
    out.set(measureId, parseSqlFile(measureId, readFileSync(path.join(dir, file), "utf8")));
  }
  return out;
}

export interface SqlExecutor {
  queryRows(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date (Codex P2: `2026-02-31` must 400, not reach `CAST(? AS DATE)`). */
export function isRealCalendarDate(v: string): boolean {
  if (!DATE_SHAPE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 1;
}

export class ComplianceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CompliancePeriod {
  start?: string;
  end: string; // the evaluation date the SQL binds
}

export function parsePeriod(searchParams: URLSearchParams, today: () => string): CompliancePeriod {
  const start = searchParams.get("start") ?? undefined;
  const end = searchParams.get("end") ?? today();
  for (const [label, v] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (v !== undefined && !isRealCalendarDate(v)) {
      throw new ComplianceError(400, `'${label}' must be a real YYYY-MM-DD calendar date (got '${v}')`);
    }
  }
  return { start, end };
}

const num = (v: unknown): number => Number(v ?? 0);

/** GET /compliance/{measureId}/cohort?start=&end= */
export async function cohortCompliance(
  sqlByMeasure: Map<string, MeasureSql>,
  executor: SqlExecutor,
  measureId: string,
  period: CompliancePeriod,
): Promise<Record<string, unknown>> {
  const m = sqlByMeasure.get(measureId);
  if (!m) throw new ComplianceError(404, `no generated SQL for measure '${measureId}'`);
  const [agg] = await executor.queryRows(m.statements["cohort"]!, [period.end]);
  const patients = await executor.queryRows(m.statements["per-patient"]!, [period.end]);
  const denominator = num(agg?.denominator);
  const numerator = num(agg?.numerator);
  return {
    measureId,
    period: effectivePeriod(m, period),
    denominator,
    numerator,
    rate: denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null,
    counts: {
      COMPLIANT: num(agg?.compliant),
      DUE_SOON: num(agg?.due_soon),
      OVERDUE: num(agg?.overdue),
      MISSING_DATA: num(agg?.missing_data),
    },
    patients: patients.map((row) => ({
      subjectId: String(row.subject_id),
      outcomeStatus: String(row.outcome_status),
      lastEventDate: row.last_event_date ?? null,
      daysSince: row.days_since === null || row.days_since === undefined ? null : num(row.days_since),
      compliant: row.outcome_status === "COMPLIANT",
    })),
  };
}

/** GET /compliance/{patientId}/{measureId}?start=&end= — Doug's single-patient question. */
export async function patientCompliance(
  sqlByMeasure: Map<string, MeasureSql>,
  executor: SqlExecutor,
  patientId: string,
  measureId: string,
  period: CompliancePeriod,
): Promise<Record<string, unknown>> {
  const m = sqlByMeasure.get(measureId);
  if (!m) throw new ComplianceError(404, `no generated SQL for measure '${measureId}'`);
  const patMatch = /^(?:wc-)?(\d+)$/.exec(patientId);
  if (!patMatch) throw new ComplianceError(400, `patientId must be 'wc-<n>' or a numeric pat_id (got '${patientId}')`);
  const [row] = await executor.queryRows(m.statements["single-patient"]!, [period.end, Number(patMatch[1])]);
  if (!row) throw new ComplianceError(404, `patient '${patientId}' not found in the WCDB population`);
  return {
    measureId,
    subjectId: String(row.subject_id),
    period: effectivePeriod(m, period),
    outcomeStatus: String(row.outcome_status),
    compliant: row.outcome_status === "COMPLIANT",
    lastEventDate: row.last_event_date ?? null,
    daysSince: row.days_since === null || row.days_since === undefined ? null : num(row.days_since),
  };
}

/**
 * The period the verdict actually reflects: the rule's own window ending at `end` (the SQL binds
 * only the evaluation date; `start` is echoed for the caller's framing but the window is the
 * measure's rule, not the caller's range — noted in the response so the demo API is honest).
 */
function effectivePeriod(m: MeasureSql, period: CompliancePeriod): Record<string, unknown> {
  return {
    ...(period.start ? { requestedStart: period.start } : {}),
    evaluationDate: period.end,
    ...(m.meta.windowDays ? { ruleWindowDays: m.meta.windowDays, ruleDueSoonDays: m.meta.dueSoonDays } : {}),
  };
}
