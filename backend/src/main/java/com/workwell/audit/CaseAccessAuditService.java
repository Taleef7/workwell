package com.workwell.audit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
public class CaseAccessAuditService {
    private static final Logger log = LoggerFactory.getLogger(CaseAccessAuditService.class);

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public CaseAccessAuditService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    @Async
    public void recordCaseViewed(
            UUID caseId,
            UUID measureVersionId,
            String actor,
            String employeeExternalId,
            String measureName,
            Instant viewedAt
    ) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("caseId", caseId == null ? null : caseId.toString());
            payload.put("employeeExternalId", employeeExternalId);
            payload.put("measureName", measureName);
            payload.put("viewedAt", viewedAt == null ? Instant.now().toString() : viewedAt.toString());

            jdbcTemplate.update(
                    """
                            INSERT INTO audit_events (
                                event_type, entity_type, entity_id, actor, ref_case_id, ref_measure_version_id, payload_json
                            ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)
                            """,
                    "CASE_VIEWED",
                    "case",
                    caseId,
                    actor,
                    caseId,
                    measureVersionId,
                    toJsonb(payload)
            );
        } catch (RuntimeException ex) {
            log.warn("Failed to record CASE_VIEWED audit event for case {}: {}", caseId, ex.getMessage());
        }
    }

    private String toJsonb(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialise CASE_VIEWED payload", ex);
        }
    }
}
