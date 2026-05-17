package com.workwell.admin;

import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Non-production demo cleanup. Truncates volatile operational tables so the app returns to a
 * clean baseline between demo sessions, then resets integration health to its initial state.
 *
 * <p>Static/seed data (employees, measures, measure_versions, value_sets, osha_references,
 * measure_value_set_links, outreach_templates, terminology_mappings) is preserved.
 *
 * <p>NOTE: this intentionally truncates {@code audit_events}, which is in tension with the
 * project-wide audit-integrity rule. It is an explicitly sprint-sanctioned demo tool and is
 * gated to non-production profiles via {@link Profile @Profile("!prod")} — in {@code prod}
 * this bean is never instantiated and the endpoint returns 403.
 */
@Service
@Profile("!prod")
public class DemoResetService {

    private final JdbcTemplate jdbcTemplate;

    public DemoResetService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional
    public void reset() {
        // FK dependency order, RESTRICT (never CASCADE): an explicit ordering makes any
        // future FK referencing these tables a deliberate decision rather than a silent
        // widening of the truncate into preserved tables. Child rows that reference
        // cases/runs (outreach_delivery_log, scheduled_appointments, outreach_records,
        // evidence_attachments, data_readiness_snapshots, case_actions, outcomes,
        // run_logs) must be cleared before their parents.
        jdbcTemplate.update("TRUNCATE TABLE outreach_delivery_log RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE audit_events RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE scheduled_appointments RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE outreach_records RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE evidence_attachments RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE data_readiness_snapshots RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE case_actions RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE cases RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE outcomes RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE run_logs RESTRICT");
        jdbcTemplate.update("TRUNCATE TABLE runs RESTRICT");

        jdbcTemplate.update(
                """
                        UPDATE integration_health
                        SET status = 'unknown',
                            last_sync_at = NULL,
                            last_sync_result = 'No successful sync has been recorded yet.'
                        """
        );
    }
}
