-- #150 H1 — one-time cleanup of the pre-bucketing "worklist flood".
--
-- Before H1, a run persisted its outcomes/cases under evaluation_period = the RAW RUN DATE,
-- so the nightly cron minted a brand-new (employee, measure, period) cohort every single day
-- and those cases never closed — ~4,703 perpetually-open cases on the live DB. H1 fixes the
-- root cause by bucketing evaluation_period to the measure's compliance CYCLE (annual → Jan 1,
-- biannual → Jan 1 / Jul 1, seasonal → Jul 1), so going forward a re-run upserts ONE case per
-- employee × measure × cycle. This migration closes the OLD per-run-date cohorts left behind.
--
-- Predicate: an OPEN/IN_PROGRESS case whose evaluation_period is NOT a cycle anchor (does not end
-- in -01-01 or -07-01). Pre-bucketing, EVERY case used a raw daily date, so this cleanly selects the
-- stale cohorts and leaves any genuinely cycle-anchored case open (the next run upserts those in
-- place). The genuinely non-compliant employees are re-opened at the correct cycle anchor by the
-- next ALL_PROGRAMS run; the worklist default (current cycle, #150 H1 Phase A) already hid these.
--
-- Status is set to CLOSED (administrative — they were never verified compliant), mirroring the
-- manual-resolve path (CaseFlowService#resolveCase), with a distinct closed_reason so the cleanup
-- is auditable and distinguishable from a user action. Every state change writes an audit_event
-- (CLAUDE.md invariant): the UPDATE … RETURNING feeds one CASE_CLOSED_STALE_PERIOD row per case via
-- a CTE — atomic. Safe + idempotent on a fresh DB (CI/Testcontainers/local seed have no stale
-- cohorts → 0 rows affected) and self-limiting if ever re-run (the rows are already CLOSED).

WITH closed AS (
    UPDATE cases
       SET status        = 'CLOSED',
           next_action   = 'Administratively closed: superseded by #150 H1 compliance-cycle bucketing.',
           updated_at    = NOW(),
           closed_at     = NOW(),
           closed_reason = 'STALE_PERIOD_CLEANUP',
           closed_by     = 'system:migration-V022'
     WHERE status IN ('OPEN', 'IN_PROGRESS')
       AND evaluation_period NOT LIKE '%-01-01'
       AND evaluation_period NOT LIKE '%-07-01'
    RETURNING id, last_run_id, measure_version_id, evaluation_period
)
INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json)
SELECT 'CASE_CLOSED_STALE_PERIOD',
       'case',
       closed.id,
       'system:migration-V022',
       closed.last_run_id,
       closed.id,
       closed.measure_version_id,
       jsonb_build_object(
           'caseId', closed.id::text,
           'closedReason', 'STALE_PERIOD_CLEANUP',
           'priorEvaluationPeriod', closed.evaluation_period,
           'note', 'Closed by migration V022: stale per-run-date cohort superseded by #150 H1 compliance-cycle bucketing.'
       )
FROM closed;
