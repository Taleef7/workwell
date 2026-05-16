-- V018__seed_historical_run_summary.sql
-- Seed MEASURE-scoped historical run summary records for the 4 active measures, spread
-- across the past 5 months, to give the Programs Overview trend charts meaningful data.
-- The trend query union branch picks these up via runs.scope_id without needing outcome rows.
-- Idempotent: uses a started_at date range guard to skip if runs already exist in that window.

DO $$
DECLARE
    r_name   TEXT;
    r_owner  TEXT;
    r_mv_id  UUID;
    v_month  INT;
    v_start  TIMESTAMPTZ;
    v_total  INT := 50;
    v_comp   INT;
BEGIN
    FOR r_name, r_owner IN
        VALUES
            ('Audiogram',           'J. Chen'),
            ('HAZWOPER Surveillance','M. Patel'),
            ('TB Surveillance',     'K. Williams'),
            ('Flu Vaccine',         'K. Williams')
    LOOP
        SELECT mv.id INTO r_mv_id
        FROM measure_versions mv
        JOIN measures m ON m.id = mv.measure_id
        WHERE m.name = r_name AND mv.status = 'ACTIVE'
        LIMIT 1;

        CONTINUE WHEN r_mv_id IS NULL;

        FOR v_month IN 1..5 LOOP
            v_start := NOW() - (v_month || ' months')::interval;

            -- Skip if a MEASURE-scoped completed run for this version already falls in the same
            -- calendar month (avoids duplication on re-runs or repeated migration testing).
            CONTINUE WHEN EXISTS (
                SELECT 1 FROM runs
                WHERE scope_type = 'MEASURE'
                  AND scope_id   = r_mv_id
                  AND status     = 'COMPLETED'
                  AND DATE_TRUNC('month', started_at) = DATE_TRUNC('month', v_start)
            );

            -- Simulate a gradual compliance decline: month-1 is best, month-5 is worst
            v_comp := GREATEST(30, 45 - (v_month * 3));

            INSERT INTO runs (
                id, scope_type, scope_id, trigger_type, status, triggered_by,
                started_at, completed_at,
                total_evaluated, compliant, non_compliant,
                duration_ms,
                measurement_period_start, measurement_period_end,
                requested_scope_json, failure_summary, partial_failure_count, dry_run
            ) VALUES (
                gen_random_uuid(),
                'MEASURE', r_mv_id,
                'SCHEDULED', 'COMPLETED', 'scheduler',
                v_start, v_start + INTERVAL '4 minutes',
                v_total, v_comp, v_total - v_comp,
                240000,
                v_start - INTERVAL '1 year', v_start,
                jsonb_build_object('scopeType', 'MEASURE'),
                NULL, 0, false
            );
        END LOOP;
    END LOOP;
END $$;
