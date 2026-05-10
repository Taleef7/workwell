package com.workwell.run;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.measure.AudiogramDemoService;
import com.workwell.measure.SyntheticEmployeeCatalog;
import com.workwell.security.SecurityActor;
import com.workwell.run.DemoRunModels.ActiveMeasureScope;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.FileCopyUtils;

@Service
public class RunPersistenceService {
    private static final Logger log = LoggerFactory.getLogger(RunPersistenceService.class);
    private static final String MEASURE_NAME = "Audiogram";

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final CaseFlowService caseFlowService;

    public RunPersistenceService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper, CaseFlowService caseFlowService) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        this.caseFlowService = caseFlowService;
    }

    @Transactional
    public void persistAudiogramRun(AudiogramDemoService.AudiogramDemoRun run) {
        List<DemoOutcome> outcomes = run.outcomes().stream()
                .map(outcome -> new DemoOutcome(
                        outcome.patientId(),
                        outcome.patientId(),
                        "demo",
                        "demo",
                        outcome.outcome(),
                        outcome.summary(),
                        outcome.evidenceJson()
                ))
                .toList();
        persistDemoRun(new DemoRunPayload(
                run.runId(),
                run.measureName(),
                run.measureVersion(),
                run.evaluationDate(),
                outcomes
        ));
    }

    @Transactional
    public void persistDemoRun(DemoRunPayload run) {
        persistMeasureRun(run, "measure", "demo", "manual", "system", Map.of(), false);
    }

    @Transactional
    public UUID persistAllProgramsRun(String runId, String scopeLabel, List<DemoRunPayload> measureRuns, String actor) {
        if (measureRuns.isEmpty()) {
            throw new IllegalArgumentException("No active measures found to execute.");
        }

        String stage = "start";
        UUID persistedRunId = UUID.fromString(runId);
        boolean runInserted = false;
        try {
            seedSyntheticEmployees();
            Instant startedAt = LocalDate.parse(measureRuns.get(0).evaluationDate()).atStartOfDay().toInstant(ZoneOffset.UTC);
            Instant completedAt = startedAt.plusSeconds(60);
            String evaluationPeriod = measureRuns.get(0).evaluationDate();

            long totalEvaluated = measureRuns.stream().mapToLong(payload -> payload.outcomes().size()).sum();
            long compliant = measureRuns.stream()
                    .flatMap(payload -> payload.outcomes().stream())
                    .filter(outcome -> "COMPLIANT".equals(outcome.outcome()))
                    .count();
            long nonCompliant = totalEvaluated - compliant;
            long partialFailureCount = countPartialFailuresAcrossRuns(measureRuns);
            String finalStatus = partialFailureCount > 0 ? "PARTIAL_FAILURE" : "COMPLETED";
            String failureSummary = partialFailureCount > 0
                    ? partialFailureCount + " measure evaluation(s) returned evaluationError"
                    : null;

            stage = "insert-run";
            jdbcTemplate.update(
                    """
                            INSERT INTO runs (
                                id, scope_type, scope_id, site, trigger_type, status, triggered_by,
                                started_at, completed_at, total_evaluated, compliant, non_compliant,
                                duration_ms, measurement_period_start, measurement_period_end,
                                requested_scope_json, failure_summary, partial_failure_count, dry_run
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
                            """,
                    ps -> {
                        ps.setObject(1, persistedRunId);
                        ps.setString(2, "all_programs");
                        ps.setNull(3, java.sql.Types.OTHER);
                        ps.setString(4, scopeLabel);
                        ps.setString(5, "manual");
                        ps.setString(6, "RUNNING");
                        ps.setString(7, actor);
                        ps.setObject(8, Timestamp.from(startedAt));
                        ps.setNull(9, java.sql.Types.TIMESTAMP);
                        ps.setLong(10, totalEvaluated);
                        ps.setLong(11, compliant);
                        ps.setLong(12, nonCompliant);
                        ps.setLong(13, 60_000L);
                        ps.setObject(14, Timestamp.from(startedAt));
                        ps.setObject(15, Timestamp.from(completedAt));
                        ps.setString(16, toJsonb(Map.of(
                                "scopeType", "ALL_PROGRAMS",
                                "scopeLabel", scopeLabel,
                                "evaluationDate", evaluationPeriod,
                                "activeMeasures", measureRuns.stream().map(DemoRunPayload::measureName).toList(),
                                "dryRun", false
                        )));
                        ps.setString(17, failureSummary);
                        ps.setLong(18, partialFailureCount);
                        ps.setBoolean(19, false);
                    }
            );
            runInserted = true;

            insertAuditEvent(
                    "RUN_STARTED",
                    "run",
                    persistedRunId,
                    actor,
                    persistedRunId,
                    null,
                    null,
                    Map.of(
                            "scope", scopeLabel,
                            "activeMeasures", measureRuns.stream().map(DemoRunPayload::measureName).toList()
                    )
            );

            stage = "insert-run-log";
            jdbcTemplate.update(
                    "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                    persistedRunId,
                    "INFO",
                    "Manual all-programs run persisted with " + totalEvaluated + " outcomes across " + measureRuns.size() + " measures."
            );

            for (DemoRunPayload payload : measureRuns) {
                stage = "ensure-measure";
                UUID measureId = ensureMeasure(payload.measureName());
                stage = "ensure-measure-version";
                UUID measureVersionId = ensureMeasureVersion(measureId, payload.measureVersion(), payload.measureName());
                List<UUID> employeeIds = ensureEmployees(payload.outcomes());

                stage = "insert-outcomes";
                for (int i = 0; i < payload.outcomes().size(); i++) {
                    DemoOutcome outcome = payload.outcomes().get(i);
                    UUID outcomeId = UUID.randomUUID();
                    UUID employeeId = employeeIds.get(i);

                    jdbcTemplate.update(
                            "INSERT INTO outcomes (id, run_id, employee_id, measure_version_id, evaluation_period, status, evidence_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)",
                            ps -> {
                                ps.setObject(1, outcomeId);
                                ps.setObject(2, persistedRunId);
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
                            actor,
                            persistedRunId,
                            null,
                            measureVersionId,
                            Map.of(
                                    "subjectId", outcome.subjectId(),
                                    "status", outcome.outcome(),
                                    "summary", outcome.summary()
                            )
                    );
                }

                stage = "upsert-cases";
                caseFlowService.upsertCases(
                        persistedRunId,
                        measureVersionId,
                        evaluationPeriod,
                        employeeIds,
                        payload.outcomes()
                );
            }

            jdbcTemplate.update(
                    """
                            UPDATE runs
                            SET status = ?,
                                completed_at = ?,
                                failure_summary = ?,
                                partial_failure_count = ?
                            WHERE id = ?
                            """,
                    finalStatus,
                    Timestamp.from(completedAt),
                    failureSummary,
                    partialFailureCount,
                    persistedRunId
            );
            insertAuditEvent(
                    "RUN_COMPLETED",
                    "run",
                    persistedRunId,
                    actor,
                    persistedRunId,
                    null,
                    null,
                    Map.of(
                            "scope", scopeLabel,
                            "evaluationDate", evaluationPeriod,
                            "totalEvaluated", totalEvaluated,
                            "compliant", compliant,
                            "nonCompliant", nonCompliant,
                            "status", finalStatus,
                            "partialFailureCount", partialFailureCount
                    )
            );
            jdbcTemplate.update(
                    "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                    persistedRunId,
                    "INFO",
                    "Run completed with status " + finalStatus + "."
            );
            return persistedRunId;
        } catch (RuntimeException ex) {
            if (runInserted) {
                markRunFailed(persistedRunId, actor, stage, ex);
            }
            log.error("Failed to persist all-programs run at stage {}: {}", stage, ex.getMessage(), ex);
            throw ex;
        }
    }

    public List<ActiveMeasureScope> loadActiveMeasureScopes() {
        String sql = """
                SELECT DISTINCT m.id,
                                m.name,
                                mv.id AS measure_version_id,
                                mv.status
                FROM measures m
                JOIN measure_versions mv ON mv.measure_id = m.id
                WHERE mv.status = 'Active'
                ORDER BY m.name ASC
                """;
        return jdbcTemplate.query(sql, (rs, rowNum) -> new ActiveMeasureScope(
                (UUID) rs.getObject("id"),
                rs.getString("name"),
                (UUID) rs.getObject("measure_version_id"),
                rs.getString("status")
        ));
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

    public Optional<RunSummaryResponse> loadRunById(UUID runId) {
        String sql = """
                SELECT r.id AS run_id,
                       r.started_at,
                       r.completed_at,
                       r.status,
                       r.trigger_type,
                       r.scope_type,
                       r.duration_ms,
                       r.total_evaluated,
                       r.compliant,
                       r.non_compliant,
                       m.name AS measure_name,
                       mv.version AS measure_version
                FROM runs r
                LEFT JOIN measure_versions mv ON r.scope_id = mv.id
                LEFT JOIN measures m ON mv.measure_id = m.id
                WHERE r.id = ?
                """;
        try {
            Map<String, Object> row = jdbcTemplate.queryForMap(sql, runId);
            List<Map<String, Object>> counts = jdbcTemplate.query(
                    """
                            SELECT status, COUNT(*) AS cnt
                            FROM outcomes
                            WHERE run_id = ?
                            GROUP BY status
                            """,
                    (rs, rowNum) -> Map.of(
                            "status", rs.getString("status"),
                            "count", rs.getLong("cnt")
                    ),
                    runId
            );
            long totalEvaluated = row.get("total_evaluated") == null ? 0 : ((Number) row.get("total_evaluated")).longValue();
            long compliantCount = row.get("compliant") == null ? 0 : ((Number) row.get("compliant")).longValue();
            long nonCompliantCount = row.get("non_compliant") == null ? 0 : ((Number) row.get("non_compliant")).longValue();
            long totalCases = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM cases WHERE last_run_id = ?",
                    Long.class,
                    runId
            );
            long durationMs = row.get("duration_ms") == null ? 0 : ((Number) row.get("duration_ms")).longValue();
            double passRate = totalEvaluated == 0 ? 0.0d : (compliantCount * 100.0d) / totalEvaluated;
            Instant dataFreshAsOf = jdbcTemplate.queryForObject(
                    "SELECT MAX(evaluated_at) FROM outcomes WHERE run_id = ?",
                    Instant.class,
                    runId
            );
            long dataFreshnessMinutes = dataFreshAsOf == null ? -1L : ChronoUnit.MINUTES.between(dataFreshAsOf, Instant.now());

            return Optional.of(new RunSummaryResponse(
                    row.get("run_id").toString(),
                    row.get("measure_name") == null ? "All Programs" : row.get("measure_name").toString(),
                    row.get("measure_version") == null ? "" : row.get("measure_version").toString(),
                    row.get("status") == null ? "" : row.get("status").toString(),
                    row.get("trigger_type") == null ? "" : row.get("trigger_type").toString(),
                    row.get("scope_type") == null ? "" : row.get("scope_type").toString(),
                    row.get("started_at") == null ? null : ((Timestamp) row.get("started_at")).toInstant(),
                    row.get("completed_at") == null ? null : ((Timestamp) row.get("completed_at")).toInstant(),
                    totalEvaluated,
                    totalCases,
                    compliantCount,
                    nonCompliantCount,
                    passRate,
                    durationMs,
                    counts,
                    dataFreshAsOf,
                    dataFreshnessMinutes
            ));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    public Optional<RunSummaryResponse> loadLatestRun() {
        try {
            UUID runId = jdbcTemplate.queryForObject(
                    "SELECT id FROM runs ORDER BY started_at DESC LIMIT 1",
                    UUID.class
            );
            if (runId == null) {
                return Optional.empty();
            }
            return loadRunById(runId);
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    public List<RunListItem> listRuns(
            String status,
            String scopeType,
            String triggerType,
            String site,
            Instant from,
            Instant to,
            int limit
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT r.id AS run_id,
                       r.status,
                       r.scope_type,
                       r.trigger_type,
                       r.started_at,
                       r.completed_at,
                       r.duration_ms,
                       r.total_evaluated,
                       r.compliant,
                       r.non_compliant,
                       m.name AS measure_name
                FROM runs r
                LEFT JOIN measure_versions mv ON r.scope_id = mv.id
                LEFT JOIN measures m ON mv.measure_id = m.id
                WHERE 1=1
                """);
        List<Object> args = new ArrayList<>();
        if (status != null && !status.isBlank()) {
            sql.append(" AND LOWER(r.status) = LOWER(?)");
            args.add(status);
        }
        if (scopeType != null && !scopeType.isBlank()) {
            sql.append(" AND LOWER(r.scope_type) = LOWER(?)");
            args.add(scopeType);
        }
        if (triggerType != null && !triggerType.isBlank()) {
            sql.append(" AND LOWER(r.trigger_type) = LOWER(?)");
            args.add(triggerType);
        }
        if (site != null && !site.isBlank()) {
            sql.append("""
                     AND EXISTS (
                         SELECT 1
                         FROM outcomes o
                         JOIN employees e ON e.id = o.employee_id
                         WHERE o.run_id = r.id
                           AND LOWER(COALESCE(e.site, '')) = LOWER(?)
                     )
                    """);
            args.add(site);
        }
        if (from != null) {
            sql.append(" AND r.started_at >= ?");
            args.add(Timestamp.from(from));
        }
        if (to != null) {
            sql.append(" AND r.started_at <= ?");
            args.add(Timestamp.from(to));
        }
        sql.append(" ORDER BY r.started_at DESC LIMIT ?");
        args.add(limit);

        return jdbcTemplate.query(sql.toString(), (rs, rowNum) -> new RunListItem(
                rs.getObject("run_id").toString(),
                rs.getString("measure_name") == null ? "All Programs" : rs.getString("measure_name"),
                rs.getString("status") == null ? "" : rs.getString("status"),
                rs.getString("scope_type") == null ? "" : rs.getString("scope_type"),
                rs.getString("trigger_type") == null ? "" : rs.getString("trigger_type"),
                rs.getTimestamp("started_at") == null ? null : rs.getTimestamp("started_at").toInstant(),
                rs.getTimestamp("completed_at") == null ? null : rs.getTimestamp("completed_at").toInstant(),
                rs.getLong("duration_ms"),
                rs.getLong("total_evaluated"),
                rs.getLong("compliant"),
                rs.getLong("non_compliant")
        ), args.toArray());
    }

    public List<RunLogEntry> loadRunLogs(UUID runId, int limit) {
        String sql = """
                SELECT ts, level, message
                FROM run_logs
                WHERE run_id = ?
                ORDER BY ts DESC
                LIMIT ?
                """;
        return jdbcTemplate.query(sql, (rs, rowNum) -> new RunLogEntry(
                rs.getTimestamp("ts").toInstant(),
                rs.getString("level"),
                rs.getString("message")
        ), runId, limit);
    }

    public Optional<RerunScope> loadRerunScope(UUID runId) {
        String sql = """
                SELECT scope_type, scope_id, site
                FROM runs
                WHERE id = ?
                """;
        try {
            Map<String, Object> row = jdbcTemplate.queryForMap(sql, runId);
            return Optional.of(new RerunScope(
                    row.get("scope_type") == null ? "" : row.get("scope_type").toString(),
                    (UUID) row.get("scope_id"),
                    row.get("site") == null ? "" : row.get("site").toString()
            ));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    public List<RunOutcomeRow> loadRunOutcomes(UUID runId) {
        String sql = """
                SELECT e.name AS employee_name,
                       e.external_id AS employee_external_id,
                       e.role,
                       e.site,
                       o.status AS outcome_status,
                       o.evidence_json,
                       c.id AS case_id
                FROM outcomes o
                JOIN employees e ON o.employee_id = e.id
                LEFT JOIN cases c
                  ON c.employee_id = o.employee_id
                 AND c.measure_version_id = o.measure_version_id
                WHERE o.run_id = ?
                ORDER BY e.name ASC
                """;
        return jdbcTemplate.query(sql, (rs, rowNum) -> {
            Map<String, Object> evidence = readJson(rs.getString("evidence_json"));
            Map<String, Object> whyFlagged = asMap(evidence.get("why_flagged"));
            String daysSinceExam = whyFlagged.get("days_since_exam") == null ? null : whyFlagged.get("days_since_exam").toString();
            String waiverStatus = whyFlagged.get("waiver_status") == null ? null : whyFlagged.get("waiver_status").toString();
            return new RunOutcomeRow(
                    rs.getString("employee_name"),
                    rs.getString("employee_external_id"),
                    rs.getString("role"),
                    rs.getString("site"),
                    rs.getString("outcome_status"),
                    daysSinceExam,
                    waiverStatus,
                    rs.getObject("case_id") == null ? null : rs.getObject("case_id").toString()
            );
        }, runId);
    }

    public List<OutcomeExportRow> loadOutcomeExportRows(UUID runId) {
        String sql = """
                SELECT o.run_id,
                       e.external_id AS employee_id,
                       e.name AS employee_name,
                       e.site,
                       m.name AS measure_name,
                       mv.version AS measure_version,
                       o.evaluation_period,
                       o.status,
                       o.evaluated_at,
                       o.evidence_json
                FROM outcomes o
                JOIN employees e ON o.employee_id = e.id
                JOIN measure_versions mv ON o.measure_version_id = mv.id
                JOIN measures m ON mv.measure_id = m.id
                WHERE o.run_id = ?
                ORDER BY o.evaluated_at ASC, o.id ASC
                """;

        return jdbcTemplate.query(sql, (rs, rowNum) -> new OutcomeExportRow(
                (UUID) rs.getObject("run_id"),
                rs.getString("employee_id"),
                rs.getString("employee_name"),
                rs.getString("site"),
                rs.getString("measure_name"),
                rs.getString("measure_version"),
                rs.getString("evaluation_period"),
                rs.getString("status"),
                outcomeSummaryFor(rs.getString("status")),
                rs.getTimestamp("evaluated_at").toInstant(),
                readJson(rs.getString("evidence_json"))
        ), runId);
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
            String summary = outcomeSummaryFor(status);
            return new AudiogramDemoService.AudiogramOutcome(patientId, status, summary, evidenceJson);
        }, runId);
    }

    private String lookupEmployeeExternalId(UUID employeeId) {
        return jdbcTemplate.queryForObject("SELECT external_id FROM employees WHERE id = ?", String.class, employeeId);
    }

    private UUID ensureMeasure(String measureName) {
        try {
            return jdbcTemplate.queryForObject("SELECT id FROM measures WHERE name = ?", UUID.class, measureName);
        } catch (EmptyResultDataAccessException ex) {
            UUID measureId = UUID.randomUUID();
            jdbcTemplate.update("INSERT INTO measures (id, name, policy_ref, owner, tags) VALUES (?, ?, ?, ?, ?)", ps -> {
                ps.setObject(1, measureId);
                ps.setString(2, measureName);
                ps.setString(3, "OSHA 29 CFR 1910.95");
                ps.setString(4, "WorkWell Studio");
                ps.setNull(5, java.sql.Types.ARRAY);
            });
            return measureId;
        }
    }

    private UUID ensureMeasureVersion(UUID measureId, String version, String measureName) {
        try {
            return jdbcTemplate.queryForObject(
                    "SELECT id FROM measure_versions WHERE measure_id = ? AND version = ?",
                    UUID.class,
                    measureId,
                    version
            );
        } catch (EmptyResultDataAccessException ex) {
            UUID measureVersionId = UUID.randomUUID();
            String cqlText = loadCqlTextForMeasure(measureName);
            Map<String, Object> specJson = Map.of(
                    "measureName", measureName,
                    "policyRef", "OSHA 29 CFR 1910.95",
                    "complianceWindowDays", 365
            );
            jdbcTemplate.update(
                    "INSERT INTO measure_versions (id, measure_id, version, status, spec_json, cql_text, compile_status, compile_result, change_summary, approved_by, activated_at) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, ?, ?)",
                    ps -> {
                        ps.setObject(1, measureVersionId);
                        ps.setObject(2, measureId);
                        ps.setString(3, version);
                        ps.setString(4, "Active");
                        ps.setString(5, toJsonb(specJson));
                        ps.setString(6, cqlText);
                        ps.setString(7, "COMPILED");
                        ps.setString(8, toJsonb(Map.of("status", "COMPILED", "warnings", List.of(), "errors", List.of())));
                        ps.setString(9, "Seeded demo measure");
                        ps.setString(10, "system");
                        ps.setObject(11, Timestamp.from(Instant.now()));
                    }
            );
            return measureVersionId;
        }
    }

    private List<UUID> ensureEmployees(List<DemoOutcome> outcomes) {
        List<UUID> employeeIds = new ArrayList<>();
        for (DemoOutcome outcome : outcomes) {
            UUID employeeId = ensureEmployee(outcome.subjectId(), outcome.subjectName(), outcome.role(), outcome.site());
            employeeIds.add(employeeId);
        }
        return employeeIds;
    }

    private UUID ensureEmployee(String externalId, String name, String role, String site) {
        try {
            return jdbcTemplate.queryForObject("SELECT id FROM employees WHERE external_id = ?", UUID.class, externalId);
        } catch (EmptyResultDataAccessException ex) {
            UUID employeeId = UUID.randomUUID();
            jdbcTemplate.update(
                    "INSERT INTO employees (id, external_id, name, role, site, active) VALUES (?, ?, ?, ?, ?, ?)",
                    ps -> {
                        ps.setObject(1, employeeId);
                        ps.setString(2, externalId);
                        ps.setString(3, name);
                        ps.setString(4, role);
                        ps.setString(5, site);
                        ps.setBoolean(6, true);
                    }
            );
            return employeeId;
        }
    }

    private void seedSyntheticEmployees() {
        // Option A seed policy: legacy patient-* rows and emp-* rows are both valid demo employees for walkthrough data.
        for (SyntheticEmployeeCatalog.EmployeeProfile employee : SyntheticEmployeeCatalog.allEmployees()) {
            try {
                UUID id = jdbcTemplate.queryForObject(
                        "SELECT id FROM employees WHERE external_id = ?",
                        UUID.class,
                        employee.externalId()
                );
                jdbcTemplate.update(
                        "UPDATE employees SET name = ?, role = ?, site = ?, active = TRUE WHERE id = ?",
                        employee.name(),
                        employee.role(),
                        employee.site(),
                        id
                );
            } catch (EmptyResultDataAccessException ex) {
                ensureEmployee(employee.externalId(), employee.name(), employee.role(), employee.site());
            }
        }
    }

    public UUID persistMeasureRun(
            DemoRunPayload run,
            String scopeType,
            String site,
            String triggerType,
            String actor,
            Map<String, Object> requestedScopeJson,
            boolean dryRun
    ) {
        String stage = "start";
        UUID runId = UUID.fromString(run.runId());
        boolean runInserted = false;
        try {
            if (dryRun) {
                throw new IllegalArgumentException("dryRun is not supported for manual measure runs yet");
            }

            long compliant = run.outcomes().stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
            long dueSoon = run.outcomes().stream().filter(o -> "DUE_SOON".equals(o.outcome())).count();
            long overdue = run.outcomes().stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
            long missingData = run.outcomes().stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
            long excluded = run.outcomes().stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();
            long partialFailureCount = countPartialFailures(run.outcomes());
            boolean evaluationFailedBeforeEmployees = requestedScopeJson != null && requestedScopeJson.containsKey("evaluationError") && run.outcomes().isEmpty();
            String finalStatus = evaluationFailedBeforeEmployees
                    ? "FAILED"
                    : partialFailureCount > 0 ? "PARTIAL_FAILURE" : "COMPLETED";
            String failureSummary = evaluationFailedBeforeEmployees
                    ? String.valueOf(requestedScopeJson.get("evaluationError"))
                    : partialFailureCount > 0
                    ? partialFailureCount + " employee evaluation(s) returned evaluationError"
                    : null;

            stage = "ensure-measure";
            UUID measureId = ensureMeasure(run.measureName());
            stage = "ensure-measure-version";
            UUID measureVersionId = ensureMeasureVersion(measureId, run.measureVersion(), run.measureName());
            stage = "ensure-employees";
            seedSyntheticEmployees();
            List<UUID> employeeIds = ensureEmployees(run.outcomes());

            Instant startedAt = LocalDate.parse(run.evaluationDate()).atStartOfDay().toInstant(ZoneOffset.UTC);
            Instant completedAt = startedAt.plusSeconds(60);
            String evaluationPeriod = run.evaluationDate();

            stage = "insert-run";
            jdbcTemplate.update(
                    """
                            INSERT INTO runs (
                                id, scope_type, scope_id, site, trigger_type, status, triggered_by,
                                started_at, completed_at, total_evaluated, compliant, non_compliant,
                                duration_ms, measurement_period_start, measurement_period_end,
                                requested_scope_json, failure_summary, partial_failure_count, dry_run
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
                            """,
                    ps -> {
                        ps.setObject(1, runId);
                        ps.setString(2, scopeType);
                        ps.setObject(3, measureVersionId);
                        ps.setString(4, site);
                        ps.setString(5, triggerType);
                        ps.setString(6, "RUNNING");
                        ps.setString(7, actor);
                        ps.setObject(8, Timestamp.from(startedAt));
                        ps.setNull(9, java.sql.Types.TIMESTAMP);
                        ps.setInt(10, run.outcomes().size());
                        ps.setLong(11, compliant);
                        ps.setLong(12, dueSoon + overdue + missingData + excluded);
                        ps.setLong(13, 60_000L);
                        ps.setObject(14, Timestamp.from(startedAt));
                        ps.setObject(15, Timestamp.from(completedAt));
                        ps.setString(16, toJsonb(requestedScopeJson == null ? Map.of() : requestedScopeJson));
                        ps.setString(17, failureSummary);
                        ps.setLong(18, partialFailureCount);
                        ps.setBoolean(19, dryRun);
                    }
            );
            runInserted = true;
            jdbcTemplate.update(
                    "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                    runId,
                    "INFO",
                    "Measure loaded: " + run.measureName() + " v" + run.measureVersion() + "."
            );

            insertAuditEvent(
                    "RUN_STARTED",
                    "run",
                    runId,
                    actor,
                    runId,
                    null,
                    measureVersionId,
                    Map.of(
                            "measureName", run.measureName(),
                            "measureVersion", run.measureVersion(),
                            "scopeType", scopeType,
                            "requestedScope", requestedScopeJson == null ? Map.of() : requestedScopeJson
                    )
            );

            stage = "insert-run-log";
            jdbcTemplate.update(
                    "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                    runId,
                    "INFO",
                    "Run requested for " + run.measureName() + " v" + run.measureVersion() + "."
            );
            jdbcTemplate.update(
                    "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                    runId,
                    "INFO",
                    "Scope resolved for " + scopeType + " run."
            );

            stage = "insert-outcomes";
            jdbcTemplate.update(
                    "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                    runId,
                    "INFO",
                    "Evaluation started for " + run.measureName() + "."
            );
            for (int i = 0; i < run.outcomes().size(); i++) {
                DemoOutcome outcome = run.outcomes().get(i);
                UUID outcomeId = UUID.randomUUID();
                UUID employeeId = employeeIds.get(i);

                jdbcTemplate.update(
                        "INSERT INTO outcomes (id, run_id, employee_id, measure_version_id, evaluation_period, status, evidence_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)",
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
                        actor,
                        runId,
                        null,
                        measureVersionId,
                        Map.of(
                                "subjectId", outcome.subjectId(),
                                "status", outcome.outcome(),
                                "summary", outcome.summary()
                        )
                );
            }
            if (evaluationFailedBeforeEmployees) {
                jdbcTemplate.update(
                        "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                        runId,
                        "ERROR",
                        "Measure evaluation failed before employee evaluation: " + failureSummary
                );
                jdbcTemplate.update(
                        "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                        runId,
                        "WARN",
                        "Outcomes were not generated because evaluation failed before employee processing."
                );
            } else {
                jdbcTemplate.update(
                        "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                        runId,
                        "INFO",
                        "Outcomes persisted for " + run.measureName() + "."
                );
                jdbcTemplate.update(
                        "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                        runId,
                        "INFO",
                        "Evaluation completed for " + run.measureName() + "."
                );
            }

            stage = "upsert-cases";
            if (!evaluationFailedBeforeEmployees) {
                caseFlowService.upsertCases(
                        runId,
                        measureVersionId,
                        evaluationPeriod,
                        employeeIds,
                        run.outcomes()
                );
                jdbcTemplate.update(
                        "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                        runId,
                        "INFO",
                        "Cases upserted for " + run.measureName() + "."
                );
            } else {
                jdbcTemplate.update(
                        "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                        runId,
                        "WARN",
                        "Cases skipped because measure evaluation failed before employee evaluation."
                );
            }

            stage = "insert-run-audit";
            insertAuditEvent(
                    "RUN_COMPLETED",
                    "run",
                    runId,
                    actor,
                    runId,
                    null,
                    measureVersionId,
                    Map.of(
                            "measureName", run.measureName(),
                            "measureVersion", run.measureVersion(),
                            "evaluationDate", run.evaluationDate(),
                            "summary", Map.of(
                                    "compliant", compliant,
                                    "dueSoon", dueSoon,
                                    "overdue", overdue,
                                    "missingData", missingData,
                                    "excluded", excluded,
                                    "partialFailureCount", partialFailureCount
                            )
                    )
            );
            jdbcTemplate.update(
                    """
                            UPDATE runs
                            SET status = ?,
                                completed_at = ?,
                                failure_summary = ?,
                                partial_failure_count = ?
                            WHERE id = ?
                            """,
                    finalStatus,
                    Timestamp.from(completedAt),
                    failureSummary,
                    partialFailureCount,
                    runId
            );
            jdbcTemplate.update(
                    "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                    runId,
                    "INFO",
                    ("FAILED".equals(finalStatus)
                            ? "Run failed with status " + finalStatus + "."
                            : "Run completed with status " + finalStatus + ".")
            );
            return runId;
        } catch (RuntimeException ex) {
            if (runInserted) {
                markRunFailed(runId, actor, stage, ex);
            }
            log.error("Failed to persist demo run at stage {}: {}", stage, ex.getMessage(), ex);
            throw ex;
        }
    }

    private void markRunFailed(UUID runId, String actor, String stage, RuntimeException ex) {
        String failureSummary = "Run failed at stage " + stage + ": " + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
        jdbcTemplate.update(
                """
                        UPDATE runs
                        SET status = 'FAILED',
                            completed_at = NOW(),
                            failure_summary = ?
                        WHERE id = ?
                        """,
                failureSummary,
                runId
        );
        jdbcTemplate.update(
                "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                runId,
                "ERROR",
                failureSummary
        );
        insertAuditEvent(
                "RUN_FAILED",
                "run",
                runId,
                actor,
                runId,
                null,
                null,
                Map.of(
                        "stage", stage,
                        "failureSummary", failureSummary
                )
        );
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
        String resolvedActor = SecurityActor.currentActorOr(actor);
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)",
                ps -> {
                    ps.setString(1, eventType);
                    ps.setString(2, entityType);
                    ps.setObject(3, entityId);
                    ps.setString(4, resolvedActor);
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

    @SuppressWarnings("unchecked")
    private Map<String, Object> asMap(Object value) {
        if (value instanceof Map<?, ?> map) {
            return (Map<String, Object>) map;
        }
        return Map.of();
    }

    private long countPartialFailures(List<DemoOutcome> outcomes) {
        return outcomes.stream()
                .filter(outcome -> {
                    Map<String, Object> evidence = outcome.evidenceJson();
                    return evidence != null && evidence.containsKey("evaluationError");
                })
                .count();
    }

    private long countPartialFailuresAcrossRuns(List<DemoRunPayload> runs) {
        return runs.stream()
                .flatMap(run -> run.outcomes().stream())
                .filter(outcome -> {
                    Map<String, Object> evidence = outcome.evidenceJson();
                    return evidence != null && evidence.containsKey("evaluationError");
                })
                .count();
    }

    private String loadCqlTextForMeasure(String measureName) {
        String filename = switch (measureName) {
            case "Audiogram" -> "audiogram.cql";
            case "TB Surveillance" -> "tb_surveillance.cql";
            case "HAZWOPER Surveillance" -> "hazwoper.cql";
            case "Flu Vaccine" -> "flu_vaccine.cql";
            default -> "audiogram.cql";
        };
        try {
            ClassPathResource resource = new ClassPathResource("measures/" + filename);
            return FileCopyUtils.copyToString(
                    new java.io.InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8)
            );
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to read CQL resource for " + measureName, ex);
        }
    }

    public record RunSummaryResponse(
            String runId,
            String measureName,
            String measureVersion,
            String status,
            String triggerType,
            String scopeType,
            Instant startedAt,
            Instant completedAt,
            long totalEvaluated,
            long totalCases,
            long compliantCount,
            long nonCompliantCount,
            double passRate,
            long durationMs,
            List<Map<String, Object>> outcomeCounts,
            Instant dataFreshAsOf,
            long dataFreshnessMinutes
    ) {
    }

    public record RunListItem(
            String runId,
            String measureName,
            String status,
            String scopeType,
            String triggerType,
            Instant startedAt,
            Instant completedAt,
            long durationMs,
            long totalEvaluated,
            long compliantCount,
            long nonCompliantCount
    ) {
    }

    public record RunLogEntry(
            Instant timestamp,
            String level,
            String message
    ) {
    }

    public record OutcomeExportRow(
            UUID runId,
            String employeeId,
            String employeeName,
            String site,
            String measureName,
            String measureVersion,
            String evaluationPeriod,
            String status,
            String summary,
            Instant evaluatedAt,
            Map<String, Object> evidenceJson
    ) {
    }

    public record RunOutcomeRow(
            String employeeName,
            String employeeExternalId,
            String role,
            String site,
            String outcomeStatus,
            String daysSinceExam,
            String waiverStatus,
            String caseId
    ) {
    }

    public record RerunScope(
            String scopeType,
            UUID scopeId,
            String site
    ) {
    }

    private String outcomeSummaryFor(String status) {
        return switch (status) {
            case "COMPLIANT" -> "Audiogram completed within compliant window.";
            case "DUE_SOON" -> "Audiogram nearing annual compliance deadline.";
            case "OVERDUE" -> "Audiogram is outside annual compliance window.";
            case "MISSING_DATA" -> "No completed audiogram date found.";
            case "EXCLUDED" -> "Active waiver document found.";
            default -> "Unknown status.";
        };
    }
}
