package com.workwell.caseflow;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class CaseSlaService {

    private static final Logger log = LoggerFactory.getLogger(CaseSlaService.class);

    private static final Map<String, Integer> SLA_DAYS = Map.of(
        "OVERDUE", 14,
        "DUE_SOON", 30,
        "MISSING_DATA", 21
    );

    private static final List<String> PRIORITY_ORDER = List.of("LOW", "MEDIUM", "HIGH", "CRITICAL");

    private final JdbcTemplate jdbcTemplate;

    public CaseSlaService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public Instant computeSlaDueDate(String outcomeStatus) {
        int days = SLA_DAYS.getOrDefault(outcomeStatus, 21);
        return Instant.now().plus(days, ChronoUnit.DAYS);
    }

    /**
     * Runs every 6 hours. Queries sla_due_date and sla_breached columns added in V020 migration.
     * Will no-op gracefully (with a debug log) until that migration is applied.
     */
    @Scheduled(cron = "0 0 */6 * * *")
    @Transactional
    public void escalateBreachedCases() {
        try {
            List<Map<String, Object>> breachedCases = jdbcTemplate.queryForList("""
                SELECT id, priority, current_outcome_status
                FROM cases
                WHERE sla_due_date < NOW()
                  AND sla_breached = FALSE
                  AND status IN ('OPEN', 'IN_PROGRESS')
                """);

            for (var c : breachedCases) {
                UUID caseId = (UUID) c.get("id");
                String currentPriority = (String) c.get("priority");
                int idx = PRIORITY_ORDER.indexOf(currentPriority);
                String newPriority = (idx >= 0 && idx < PRIORITY_ORDER.size() - 1)
                    ? PRIORITY_ORDER.get(idx + 1) : "CRITICAL";

                jdbcTemplate.update("""
                    UPDATE cases
                    SET priority = ?, sla_breached = TRUE,
                        next_action = 'SLA breached — immediate action required',
                        updated_at = NOW()
                    WHERE id = ?
                    """, newPriority, caseId);

                // Write audit event inline (same pattern as CaseFlowService.insertAuditEvent)
                jdbcTemplate.update("""
                    INSERT INTO audit_events
                        (event_type, entity_type, entity_id, actor, ref_case_id, payload_json, occurred_at)
                    VALUES (?, ?, ?, ?, ?, ?::jsonb, NOW())
                    """,
                    "CASE_SLA_BREACHED",
                    "case",
                    caseId,
                    "scheduler",
                    caseId,
                    String.format("{\"previousPriority\":\"%s\",\"newPriority\":\"%s\"}", currentPriority, newPriority)
                );
            }

            if (!breachedCases.isEmpty()) {
                log.info("SLA escalation: {} case(s) escalated", breachedCases.size());
            }
        } catch (DataAccessException ex) {
            // V020 migration (sla_due_date and sla_breached columns) not yet applied — skip silently
            log.debug("SLA escalation skipped (V020 migration pending): {}", ex.getMessage());
        }
    }
}
