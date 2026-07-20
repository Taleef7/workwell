-- GENERATED FILE — do not edit by hand. Regenerate with:  cd backend-ts && pnpm generate:sql
-- Source: rule params for 'diabetes_hba1c' (windowed-recency: windowDays=180, dueSoonDays=20, gracePeriodDays=0)
--         + crosswalk LOINC codes [4548-4] (engine/ingress/webchart/terminology.ts)
-- Codegen: backend-ts/src/engine/cql/codegen/generate-sql.ts (#292 / ADR-034; parity-gated per ADR-025)
-- Statements are separated by '-- @statement <name>' markers; runtime values are '?' placeholders.

-- @statement per-patient  (params: eval_date)
SELECT
  p.pat_id,
  CONCAT('wc-', p.pat_id) AS subject_id,
  last_ev.dt AS last_event_date,
  CASE WHEN last_ev.dt IS NULL THEN NULL ELSE DATEDIFF(params.eval_date, last_ev.dt) END AS days_since,
  CASE
    WHEN last_ev.dt IS NULL THEN 'MISSING_DATA'
    WHEN DATEDIFF(params.eval_date, last_ev.dt) > 180 THEN 'OVERDUE'
    WHEN DATEDIFF(params.eval_date, last_ev.dt) > 160 THEN 'DUE_SOON'
    ELSE 'COMPLIANT'
  END AS outcome_status
FROM (SELECT CAST(? AS DATE) AS eval_date) params
CROSS JOIN patients p
LEFT JOIN (
  SELECT o.pat_id, MAX(DATE(COALESCE(o.obs_result_dt, o.obs_ts))) AS dt
  FROM observations_current o
  JOIN observation_codes oc ON oc.obs_code = o.obs_code
  WHERE oc.loinc_num IN ('4548-4')
    AND COALESCE(o.obs_result_dt, o.obs_ts) IS NOT NULL
    AND DATE(COALESCE(o.obs_result_dt, o.obs_ts)) > DATE('1900-01-01')
  GROUP BY o.pat_id
) last_ev ON last_ev.pat_id = p.pat_id
WHERE p.is_patient = 1
ORDER BY p.pat_id;

-- @statement single-patient  (params: eval_date, pat_id)
SELECT
  p.pat_id,
  CONCAT('wc-', p.pat_id) AS subject_id,
  last_ev.dt AS last_event_date,
  CASE WHEN last_ev.dt IS NULL THEN NULL ELSE DATEDIFF(params.eval_date, last_ev.dt) END AS days_since,
  CASE
    WHEN last_ev.dt IS NULL THEN 'MISSING_DATA'
    WHEN DATEDIFF(params.eval_date, last_ev.dt) > 180 THEN 'OVERDUE'
    WHEN DATEDIFF(params.eval_date, last_ev.dt) > 160 THEN 'DUE_SOON'
    ELSE 'COMPLIANT'
  END AS outcome_status
FROM (SELECT CAST(? AS DATE) AS eval_date) params
CROSS JOIN patients p
LEFT JOIN (
  SELECT o.pat_id, MAX(DATE(COALESCE(o.obs_result_dt, o.obs_ts))) AS dt
  FROM observations_current o
  JOIN observation_codes oc ON oc.obs_code = o.obs_code
  WHERE oc.loinc_num IN ('4548-4')
    AND COALESCE(o.obs_result_dt, o.obs_ts) IS NOT NULL
    AND DATE(COALESCE(o.obs_result_dt, o.obs_ts)) > DATE('1900-01-01')
  GROUP BY o.pat_id
) last_ev ON last_ev.pat_id = p.pat_id
WHERE p.is_patient = 1
  AND p.pat_id = ?;

-- @statement cohort  (params: eval_date)
SELECT
  COUNT(*) AS denominator,
  SUM(outcome_status = 'COMPLIANT') AS numerator,
  SUM(outcome_status = 'COMPLIANT') AS compliant,
  SUM(outcome_status = 'DUE_SOON') AS due_soon,
  SUM(outcome_status = 'OVERDUE') AS overdue,
  SUM(outcome_status = 'MISSING_DATA') AS missing_data
FROM (
  SELECT
    p.pat_id,
    CONCAT('wc-', p.pat_id) AS subject_id,
    last_ev.dt AS last_event_date,
    CASE WHEN last_ev.dt IS NULL THEN NULL ELSE DATEDIFF(params.eval_date, last_ev.dt) END AS days_since,
    CASE
      WHEN last_ev.dt IS NULL THEN 'MISSING_DATA'
      WHEN DATEDIFF(params.eval_date, last_ev.dt) > 180 THEN 'OVERDUE'
      WHEN DATEDIFF(params.eval_date, last_ev.dt) > 160 THEN 'DUE_SOON'
      ELSE 'COMPLIANT'
    END AS outcome_status
  FROM (SELECT CAST(? AS DATE) AS eval_date) params
  CROSS JOIN patients p
  LEFT JOIN (
    SELECT o.pat_id, MAX(DATE(COALESCE(o.obs_result_dt, o.obs_ts))) AS dt
    FROM observations_current o
    JOIN observation_codes oc ON oc.obs_code = o.obs_code
    WHERE oc.loinc_num IN ('4548-4')
      AND COALESCE(o.obs_result_dt, o.obs_ts) IS NOT NULL
      AND DATE(COALESCE(o.obs_result_dt, o.obs_ts)) > DATE('1900-01-01')
    GROUP BY o.pat_id
  ) last_ev ON last_ev.pat_id = p.pat_id
  WHERE p.is_patient = 1
) per_patient;
