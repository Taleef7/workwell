package com.workwell.run;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.measure.AudiogramDemoService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.FileCopyUtils;

@Service
public class RunPersistenceService {
    private static final String MEASURE_NAME = "AnnualAudiogramCompleted";
    private static final String MEASURE_VERSION = "1.0.0";

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public RunPersistenceService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public void persistAudiogramRun(AudiogramDemoService.AudiogramDemoRun run) {
        UUID measureId = ensureMeasure();
        UUID measureVersionId = ensureMeasureVersion(measureId);
        List<UUID> employeeIds = ensureEmployees(run.outcomes());

        UUID runId = UUID.fromString(run.runId());
        Instant startedAt = LocalDate.parse(run.evaluationDate()).atStartOfDay().toInstant(ZoneOffset.UTC);
        Instant completedAt = startedAt.plusSeconds(60);
        String evaluationPeriod = run.evaluationDate();

        jdbcTemplate.update(
                "INSERT INTO runs (id, scope_type, scope_id, site, trigger_type, status, triggered_by, started_at, completed_at, total_evaluated, compliant, non_compliant, duration_ms, measurement_period_start, measurement_period_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ps -> {
                    ps.setObject(1, runId);
                    ps.setString(2, "measure");
                    ps.setObject(3, measureVersionId);
                    ps.setString(4, "demo");
                    ps.setString(5, "manual");
                    ps.setString(6, "completed");
                    ps.setString(7, "system");
                    ps.setObject(8, Timestamp.from(startedAt));
                    ps.setObject(9, Timestamp.from(completedAt));
                    ps.setInt(10, run.outcomes().size());
                    ps.setLong(11, run.summary().compliant());
                    ps.setLong(12, run.summary().dueSoon() + run.summary().overdue() + run.summary().missingData() + run.summary().excluded());
                    ps.setLong(13, 60_000L);
                    ps.setObject(14, Timestamp.from(startedAt));
                    ps.setObject(15, Timestamp.from(completedAt));
                }
        );

        jdbcTemplate.update(
                "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                runId,
                "INFO",
                "Seeded audiogram run persisted with " + run.outcomes().size() + " outcomes."
        );

        for (int i = 0; i < run.outcomes().size(); i++) {
            AudiogramDemoService.AudiogramOutcome outcome = run.outcomes().get(i);
            UUID outcomeId = UUID.randomUUID();
            UUID employeeId = employeeIds.get(i);

            jdbcTemplate.update(
                    "INSERT INTO outcomes (id, run_id, employee_id, measure_version_id, evaluation_period, status, evidence_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    ps -> {
                        ps.setObject(1, outcomeId);
                        ps.setObject(2, runId);
                        ps.setObject(3, employeeId);
                        ps.setObject(4, measureVersionId);
                        ps.setString(5, evaluationPeriod);
                        ps.setString(6, outcome.outcome());
                        ps.setString(7, toJsonb(outcome.evidenceJson()));
                        ps.setObject(8, Timestamp.from(Instant.now()));
                    }
            );

            insertAuditEvent(
                    "OUTCOME_PERSISTED",
                    "outcome",
                    outcomeId,
                    "system",
                    runId,
                    null,
                    measureVersionId,
                    Map.of(
                            "patientId", outcome.patientId(),
                            "status", outcome.outcome(),
                            "summary", outcome.summary()
                    )
            );
        }

        insertAuditEvent(
                "RUN_PERSISTED",
                "run",
                runId,
                "system",
                runId,
                null,
                measureVersionId,
                Map.of(
                        "measureName", run.measureName(),
                        "measureVersion", run.measureVersion(),
                        "evaluationDate", run.evaluationDate(),
                        "summary", Map.of(
                                "compliant", run.summary().compliant(),
                                "dueSoon", run.summary().dueSoon(),
                                "overdue", run.summary().overdue(),
                                "missingData", run.summary().missingData(),
                                "excluded", run.summary().excluded()
                        )
                )
        );
    }

    public Optional<AudiogramDemoService.AudiogramDemoRun> loadLatestAudiogramRun() {
        String sql = """
                SELECT r.id AS run_id,
                       r.started_at,
                       r.total_evaluated,
                       r.compliant,
                       r.non_compliant,
                       r.measurement_period_start,
                       r.measurement_period_end,
                       m.name AS measure_name,
                       mv.version AS measure_version,
                       mv.id AS measure_version_id
                FROM runs r
                JOIN measure_versions mv ON r.scope_id = mv.id
                JOIN measures m ON mv.measure_id = m.id
                WHERE m.name = ?
                ORDER BY r.started_at DESC
                LIMIT 1
                """;

        try {
            var row = jdbcTemplate.queryForMap(sql, MEASURE_NAME);
            UUID runId = (UUID) row.get("run_id");
            Timestamp measurementPeriodStart = (Timestamp) row.get("measurement_period_start");
            List<AudiogramDemoService.AudiogramOutcome> outcomes = loadOutcomesForRun(runId);

            long compliant = outcomes.stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
            long dueSoon = outcomes.stream().filter(o -> "DUE_SOON".equals(o.outcome())).count();
            long overdue = outcomes.stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
            long missingData = outcomes.stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
            long excluded = outcomes.stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();

            return Optional.of(new AudiogramDemoService.AudiogramDemoRun(
                    runId.toString(),
                    (String) row.get("measure_name"),
                    (String) row.get("measure_version"),
                    measurementPeriodStart.toLocalDateTime().toLocalDate().toString(),
                    new AudiogramDemoService.RunSummary(compliant, dueSoon, overdue, missingData, excluded),
                    outcomes
            ));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    private List<AudiogramDemoService.AudiogramOutcome> loadOutcomesForRun(UUID runId) {
        String sql = """
                SELECT o.employee_id, o.status, o.evidence_json
                FROM outcomes o
                WHERE o.run_id = ?
                ORDER BY o.evaluated_at ASC
                """;

        return jdbcTemplate.query(sql, (rs, rowNum) -> {
            String patientId = lookupEmployeeExternalId((UUID) rs.getObject("employee_id"));
            String status = rs.getString("status");
            Map<String, Object> evidenceJson = readJson(rs.getString("evidence_json"));
            String summary = switch (status) {
                case "COMPLIANT" -> "Audiogram completed within compliant window.";
                case "DUE_SOON" -> "Audiogram nearing annual compliance deadline.";
                case "OVERDUE" -> "Audiogram is outside annual compliance window.";
                case "MISSING_DATA" -> "No completed audiogram date found.";
                case "EXCLUDED" -> "Active waiver document found.";
                default -> "Unknown status.";
            };
            return new AudiogramDemoService.AudiogramOutcome(patientId, status, summary, evidenceJson);
        }, runId);
    }

    private String lookupEmployeeExternalId(UUID employeeId) {
        return jdbcTemplate.queryForObject("SELECT external_id FROM employees WHERE id = ?", String.class, employeeId);
    }

    private UUID ensureMeasure() {
        try {
            return jdbcTemplate.queryForObject("SELECT id FROM measures WHERE name = ?", UUID.class, MEASURE_NAME);
        } catch (EmptyResultDataAccessException ex) {
            UUID measureId = UUID.randomUUID();
            jdbcTemplate.update("INSERT INTO measures (id, name, policy_ref, owner, tags) VALUES (?, ?, ?, ?, ?)", ps -> {
                ps.setObject(1, measureId);
                ps.setString(2, MEASURE_NAME);
                ps.setString(3, "OSHA 29 CFR 1910.95");
                ps.setString(4, "WorkWell Studio");
                ps.setNull(5, java.sql.Types.ARRAY);
            });
            return measureId;
        }
    }

    private UUID ensureMeasureVersion(UUID measureId) {
        try {
            return jdbcTemplate.queryForObject(
                    "SELECT id FROM measure_versions WHERE measure_id = ? AND version = ?",
                    UUID.class,
                    measureId,
                    MEASURE_VERSION
            );
        } catch (EmptyResultDataAccessException ex) {
            UUID measureVersionId = UUID.randomUUID();
            String cqlText = loadCqlText();
            Map<String, Object> specJson = Map.of(
                    "measureName", MEASURE_NAME,
                    "policyRef", "OSHA 29 CFR 1910.95",
                    "complianceWindowDays", 365
            );
            jdbcTemplate.update(
                    "INSERT INTO measure_versions (id, measure_id, version, status, spec_json, cql_text, compile_status, compile_result, change_summary, approved_by, activated_at) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, ?, ?)",
                    ps -> {
                        ps.setObject(1, measureVersionId);
                        ps.setObject(2, measureId);
                        ps.setString(3, MEASURE_VERSION);
                        ps.setString(4, "Active");
                        ps.setString(5, toJsonb(specJson));
                        ps.setString(6, cqlText);
                        ps.setString(7, "Compiled");
                        ps.setString(8, toJsonb(Map.of("status", "Compiled", "warnings", List.of())));
                        ps.setString(9, "Seeded demo measure");
                        ps.setString(10, "system");
                        ps.setObject(11, Timestamp.from(Instant.now()));
                    }
            );
            return measureVersionId;
        }
    }

    private List<UUID> ensureEmployees(List<AudiogramDemoService.AudiogramOutcome> outcomes) {
        List<UUID> employeeIds = new ArrayList<>();
        for (AudiogramDemoService.AudiogramOutcome outcome : outcomes) {
            UUID employeeId = ensureEmployee(outcome.patientId());
            employeeIds.add(employeeId);
        }
        return employeeIds;
    }

    private UUID ensureEmployee(String externalId) {
        try {
            return jdbcTemplate.queryForObject("SELECT id FROM employees WHERE external_id = ?", UUID.class, externalId);
        } catch (EmptyResultDataAccessException ex) {
            UUID employeeId = UUID.randomUUID();
            jdbcTemplate.update(
                    "INSERT INTO employees (id, external_id, name, role, site, active) VALUES (?, ?, ?, ?, ?, ?)",
                    ps -> {
                        ps.setObject(1, employeeId);
                        ps.setString(2, externalId);
                        ps.setString(3, externalId);
                        ps.setString(4, "demo");
                        ps.setString(5, "demo");
                        ps.setBoolean(6, true);
                    }
            );
            return employeeId;
        }
    }

    private void insertAuditEvent(
            String eventType,
            String entityType,
            UUID entityId,
            String actor,
            UUID refRunId,
            UUID refCaseId,
            UUID refMeasureVersionId,
            Map<String, Object> payload
    ) {
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)",
                ps -> {
                    ps.setString(1, eventType);
                    ps.setString(2, entityType);
                    ps.setObject(3, entityId);
                    ps.setString(4, actor);
                    ps.setObject(5, refRunId);
                    ps.setObject(6, refCaseId);
                    ps.setObject(7, refMeasureVersionId);
                    ps.setString(8, toJsonb(payload));
                }
        );
    }

    private String toJsonb(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialise JSON payload", ex);
        }
    }

    private Map<String, Object> readJson(String json) {
        try {
            return objectMapper.readValue(json, Map.class);
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to parse JSON payload", ex);
        }
    }

    private String loadCqlText() {
        try {
            ClassPathResource resource = new ClassPathResource("measures/audiogram.cql");
            return FileCopyUtils.copyToString(
                    new java.io.InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8)
            );
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to read audiogram CQL resource", ex);
        }
    }
}
