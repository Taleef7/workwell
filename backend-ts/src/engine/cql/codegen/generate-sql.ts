/**
 * Rule-params → WCDB SQL codegen (#292 E9 Option B, ADR-034 — the 2026-07-19 Doug directive:
 * "read this CQL and give me the SQL, and here's the schema").
 *
 * The second backend beside `generate-cql.ts`: the SAME windowed-recency rule params that compile to
 * CQL also template to parameterized MariaDB SQL over the WebChart dev-DB schema
 * (`patients ⋈ observations_current ⋈ observation_codes`). Transpiling from RULE PARAMS — never from
 * CQL text — sidesteps CQL's three-valued-logic/interval semantics; equivalence is proven
 * EMPIRICALLY per measure by the golden-parity harness (the CQL engine over the shim's FHIR output
 * is the oracle — ADR-025: a measure that has never passed parity is never served by SQL).
 *
 * Pure string templating: NO database driver here (backend-ts is MariaDB-driver-free — locked
 * 2026-07-03, reaffirmed ADR-034). Execution lives in `wcdb-fhir-shim/` (which owns mysql2); the
 * generated statements are committed there (`wcdb-fhir-shim/sql/*.sql`) by `pnpm generate:sql` and
 * freshness-tested. Runtime values (evaluation date, patient id) are `?` placeholders bound by the
 * executor; LOINC codes are trusted, code-controlled measure params (the `generateCql` stance) and
 * are validated + inlined as quoted literals.
 *
 * Semantics mirrored from the CQL (windowed-recency, `generate-cql.ts` + the hand-written
 * hypertension/cholesterol/BMI/HbA1c measures, all the same shape):
 *   days      = DATEDIFF(eval_date, most recent qualifying event date)   [calendar days]
 *   MISSING   when no qualifying event exists
 *   OVERDUE   when days > windowDays + gracePeriodDays
 *   DUE_SOON  when days > windowDays - dueSoonDays (and <= the overdue threshold)
 *   COMPLIANT otherwise (includes future-dated events — CQL's Last() has no upper date bound)
 * Enrollment/waiver gates are not in the SQL: on the live WCDB path every subject is
 * roster-enrolled WorkWell-side and WCDB carries no waiver Conditions (see the wave spec §5).
 * The date guard excludes ONLY MariaDB zero-dates (`< 0001-01-01`) — the exact analog of the
 * FHIR path's `fhirDate` zero-date strip — so any real historical date (even pre-1901) flows
 * through and bands OVERDUE on both paths (Codex P2: a wider guard would divert valid ancient
 * dates to MISSING_DATA here while the CQL oracle reads them OVERDUE).
 *
 * Descriptive only (ADR-008): the SQL classifies rows for the shim's demo compliance API; CQL
 * remains the sole `Outcome Status` authority in the product.
 */
import { validateRule, type Rule } from "./generate-cql.ts";

export interface GenerateSqlInput {
  measureId: string;
  rule: Extract<Rule, { type: "windowed-recency" }>;
  /** LOINC codes whose observations satisfy the measure — from `loincCodesForMeasure` (the crosswalk). */
  loincCodes: string[];
}

export interface GeneratedSql {
  measureId: string;
  /** One row per patient: (pat_id, subject_id, last_event_date, days_since, outcome_status). Params: [eval_date]. */
  perPatient: string;
  /** One aggregate row: numerator/denominator + the per-status counts. Params: [eval_date]. */
  cohort: string;
  /** One row for one patient. Params: [eval_date, pat_id]. */
  singlePatient: string;
}

const LOINC_SHAPE = /^[0-9]{1,7}-[0-9]$/;

function quotedLoincList(codes: string[]): string {
  if (codes.length === 0) throw new Error("loincCodes must be non-empty");
  for (const c of codes) {
    if (!LOINC_SHAPE.test(c)) throw new Error(`'${c}' is not a plausible LOINC code (refusing to inline)`);
  }
  return codes.map((c) => `'${c}'`).join(",");
}

/**
 * The shared per-patient classification SELECT. `?` = the evaluation date (bound once via the
 * `params` derived table so each statement takes it exactly one time).
 */
function perPatientSelect(input: GenerateSqlInput): string {
  const { windowDays, dueSoonDays, gracePeriodDays } = input.rule;
  const compliantMax = windowDays - dueSoonDays;
  const overdueThreshold = windowDays + (gracePeriodDays ?? 0);
  const loincs = quotedLoincList(input.loincCodes);
  return `SELECT
  p.pat_id,
  CONCAT('wc-', p.pat_id) AS subject_id,
  last_ev.dt AS last_event_date,
  CASE WHEN last_ev.dt IS NULL THEN NULL ELSE DATEDIFF(params.eval_date, last_ev.dt) END AS days_since,
  CASE
    WHEN last_ev.dt IS NULL THEN 'MISSING_DATA'
    WHEN DATEDIFF(params.eval_date, last_ev.dt) > ${overdueThreshold} THEN 'OVERDUE'
    WHEN DATEDIFF(params.eval_date, last_ev.dt) > ${compliantMax} THEN 'DUE_SOON'
    ELSE 'COMPLIANT'
  END AS outcome_status
FROM (SELECT CAST(? AS DATE) AS eval_date) params
CROSS JOIN patients p
LEFT JOIN (
  SELECT o.pat_id, MAX(DATE(COALESCE(o.obs_result_dt, o.obs_ts))) AS dt
  FROM observations_current o
  JOIN observation_codes oc ON oc.obs_code = o.obs_code
  WHERE oc.loinc_num IN (${loincs})
    AND COALESCE(o.obs_result_dt, o.obs_ts) IS NOT NULL
    AND DATE(COALESCE(o.obs_result_dt, o.obs_ts)) >= DATE('0001-01-01')
  GROUP BY o.pat_id
) last_ev ON last_ev.pat_id = p.pat_id
WHERE p.is_patient = 1`;
}

export function generateSql(input: GenerateSqlInput): GeneratedSql {
  if (input.rule.type !== "windowed-recency") {
    // Series-completion SQL is a #292 follow-up: WCDB has no immunization table, so it could
    // never reach ADR-025 parity against this database.
    throw new Error(`generateSql supports windowed-recency only (got '${(input.rule as Rule).type}')`);
  }
  validateRule(input.rule);
  const base = perPatientSelect(input);
  return {
    measureId: input.measureId,
    perPatient: `${base}\nORDER BY p.pat_id;`,
    singlePatient: `${base}\n  AND p.pat_id = ?;`,
    cohort: `SELECT
  COUNT(*) AS denominator,
  COALESCE(SUM(outcome_status = 'COMPLIANT'), 0) AS numerator,
  COALESCE(SUM(outcome_status = 'COMPLIANT'), 0) AS compliant,
  COALESCE(SUM(outcome_status = 'DUE_SOON'), 0) AS due_soon,
  COALESCE(SUM(outcome_status = 'OVERDUE'), 0) AS overdue,
  COALESCE(SUM(outcome_status = 'MISSING_DATA'), 0) AS missing_data
FROM (
${base
  .split("\n")
  .map((l) => (l ? `  ${l}` : l))
  .join("\n")}
) per_patient;`,
  };
}

/** The generated-file banner stamped onto every committed `.sql` artifact. */
export function sqlFileHeader(measureId: string, input: GenerateSqlInput): string {
  const { windowDays, dueSoonDays, gracePeriodDays } = input.rule;
  return `-- GENERATED FILE — do not edit by hand. Regenerate with:  cd backend-ts && pnpm generate:sql
-- Source: rule params for '${measureId}' (windowed-recency: windowDays=${windowDays}, dueSoonDays=${dueSoonDays}, gracePeriodDays=${gracePeriodDays ?? 0})
--         + crosswalk LOINC codes [${input.loincCodes.join(", ")}] (engine/ingress/webchart/terminology.ts)
-- Codegen: backend-ts/src/engine/cql/codegen/generate-sql.ts (#292 / ADR-034; parity-gated per ADR-025)
-- Statements are separated by '-- @statement <name>' markers; runtime values are '?' placeholders.
`;
}

/** Serialize the three statements into one committed `.sql` artifact the shim can parse. */
export function toSqlFile(measureId: string, input: GenerateSqlInput): string {
  const g = generateSql(input);
  return (
    sqlFileHeader(measureId, input) +
    `\n-- @statement per-patient  (params: eval_date)\n${g.perPatient}\n` +
    `\n-- @statement single-patient  (params: eval_date, pat_id)\n${g.singlePatient}\n` +
    `\n-- @statement cohort  (params: eval_date)\n${g.cohort}\n`
  );
}
