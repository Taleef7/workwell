package com.workwell.run;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.compile.CqlEvaluationService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.SyntheticEmployeeCatalog;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import com.workwell.web.EvalController.ManualRunResponse;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
public class AllProgramsRunService {
    private static final Logger log = LoggerFactory.getLogger(AllProgramsRunService.class);

    private final RunPersistenceService runPersistenceService;
    private final MeasureService measureService;
    private final JdbcTemplate jdbcTemplate;
    private final CqlEvaluationService cqlEvaluationService;
    private final CaseFlowService caseFlowService;
    private final ObjectMapper objectMapper;

    public AllProgramsRunService(
            RunPersistenceService runPersistenceService,
            MeasureService measureService,
            JdbcTemplate jdbcTemplate,
            CqlEvaluationService cqlEvaluationService,
            CaseFlowService caseFlowService,
            ObjectMapper objectMapper
    ) {
        this.runPersistenceService = runPersistenceService;
        this.measureService = measureService;
        this.jdbcTemplate = jdbcTemplate;
        this.cqlEvaluationService = cqlEvaluationService;
        this.caseFlowService = caseFlowService;
        this.objectMapper = objectMapper;
    }

    public ManualRunResponse run(ManualRunRequest request, String triggerActor) {
        if (request == null || request.scopeType() == null) {
            throw new IllegalArgumentException("scopeType is required");
        }

        RunScopeType scopeType = request.scopeType();
        return switch (scopeType) {
            case ALL_PROGRAMS -> runAllPrograms("All Programs", triggerActor, effectiveEvaluationDate(request));
            case MEASURE -> runMeasureScope(request, triggerActor);
            case CASE -> runCaseScope(request, triggerActor);
            case SITE -> throw new IllegalArgumentException("Scope SITE is not implemented yet");
            case EMPLOYEE -> throw new IllegalArgumentException("Scope EMPLOYEE is not implemented yet");
        };
    }

    public UUID createRunRecord(ManualRunRequest request, String actor) {
        return createRunRecord(request, actor, "manual");
    }

    public UUID createRunRecord(ManualRunRequest request, String actor, String triggerType) {
        validateScopeRequest(request);
        UUID runId = UUID.randomUUID();
        UUID scopeId = resolveScopeId(request);
        String scopeTypeStr = request.scopeType().name().toLowerCase();
        String requestedScopeJson = buildRequestedScopeJson(request);
        runPersistenceService.createPendingRun(runId, scopeTypeStr, triggerType, actor,
                requestedScopeJson, scopeId, effectiveEvaluationDate(request));
        return runId;
    }

    private void validateScopeRequest(ManualRunRequest request) {
        switch (request.scopeType()) {
            case SITE -> {
                if (request.site() == null || request.site().isBlank()) {
                    throw new IllegalArgumentException("SITE scope requires 'site' field");
                }
            }
            case EMPLOYEE -> {
                if (request.employeeExternalId() == null || request.employeeExternalId().isBlank()) {
                    throw new IllegalArgumentException("EMPLOYEE scope requires 'employeeExternalId' field");
                }
            }
            case MEASURE -> {
                if (request.measureId() == null && request.measureVersionId() == null) {
                    throw new IllegalArgumentException("MEASURE scope requires 'measureId' or 'measureVersionId' field");
                }
            }
            default -> { /* ALL_PROGRAMS / CASE: no extra fields required */ }
        }
    }

    private UUID resolveScopeId(ManualRunRequest request) {
        if (request.scopeType() != RunScopeType.MEASURE) return null;
        // measureVersionId takes priority
        if (request.measureVersionId() != null) return request.measureVersionId();
        // fall back to looking up the active version for the measure
        if (request.measureId() != null) {
            try {
                return jdbcTemplate.queryForObject(
                        """
                        SELECT mv.id
                        FROM measure_versions mv
                        WHERE mv.measure_id = ?
                          AND mv.status = 'Active'
                        ORDER BY mv.created_at DESC
                        LIMIT 1
                        """,
                        UUID.class,
                        request.measureId()
                );
            } catch (org.springframework.dao.EmptyResultDataAccessException ex) {
                return null;
            }
        }
        return null;
    }

    @Async("runExecutor")
    public void executeRunAsync(UUID runId, ManualRunRequest request, String actor) {
        try {
            runPersistenceService.updateRunStatus(runId, "RUNNING");
            LocalDate evaluationDate = effectiveEvaluationDate(request);
            List<DemoRunPayload> payloads = evaluateForScopeAsync(request, runId, evaluationDate);
            String scopeLabel = buildScopeLabel(request);
            runPersistenceService.finalizeAsyncRun(runId, scopeLabel, payloads, actor);
        } catch (Exception e) {
            log.error("Async run {} failed: {}", runId, e.getMessage(), e);
            try {
                runPersistenceService.updateRunStatus(runId, "FAILED");
                runPersistenceService.setFailureSummary(runId, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            } catch (Exception inner) {
                log.error("Failed to mark run {} as FAILED: {}", runId, inner.getMessage());
            }
        }
    }

    public ManualRunResponse runAllPrograms(String scopeLabel, String triggerActor) {
        return runAllPrograms(scopeLabel, triggerActor, LocalDate.now());
    }

    public ManualRunResponse runAllPrograms(String scopeLabel, String triggerActor, LocalDate evaluationDate) {
        measureService.listMeasures();
        UUID runId = UUID.randomUUID();
        List<DemoRunPayload> payloads = runPersistenceService.loadActiveMeasureScopes().stream()
                .map(scopeRow -> evaluateMeasureScope(runId, scopeRow.measureName(), scopeRow.measureVersionId(), evaluationDate))
                .filter(payload -> payload != null)
                .toList();
        UUID persistedRunId = runPersistenceService.persistAllProgramsRun(runId.toString(), scopeLabel, payloads, triggerActor);
        return buildResponse(
                persistedRunId,
                RunScopeType.ALL_PROGRAMS.name(),
                scopeLabel,
                payloads.stream().map(DemoRunPayload::measureName).toList()
        );
    }

    public ManualRunResponse rerunSameScope(UUID sourceRunId, String triggerActor) {
        RunPersistenceService.RerunScope scope = runPersistenceService.loadRerunScope(sourceRunId)
                .orElseThrow(() -> new IllegalArgumentException("Source run not found: " + sourceRunId));
        if ("all_programs".equalsIgnoreCase(scope.scopeType())) {
            return runAllPrograms("All Programs", triggerActor, LocalDate.now());
        }
        if (!"measure".equalsIgnoreCase(scope.scopeType()) || scope.scopeId() == null) {
            if ("case".equalsIgnoreCase(scope.scopeType())) {
                UUID caseId = loadCaseIdForRun(sourceRunId, scope.scopeId());
                return runCaseScope(new ManualRunRequest(
                        RunScopeType.CASE,
                        null,
                        null,
                        null,
                        null,
                        caseId,
                        null,
                        false
                ), triggerActor);
            }
            throw new IllegalArgumentException("Unsupported run scope type: " + scope.scopeType());
        }

        Map<String, Object> row = jdbcTemplate.queryForMap(
                """
                        SELECT m.id AS measure_id,
                               m.name AS measure_name,
                               mv.version AS version,
                               mv.cql_text AS cql_text
                        FROM measure_versions mv
                        JOIN measures m ON m.id = mv.measure_id
                        WHERE mv.id = ?
                        """,
                scope.scopeId()
        );
        UUID rerunId = UUID.randomUUID();
        LocalDate evaluationDate = LocalDate.now();
        DemoRunPayload payload;
        try {
            payload = cqlEvaluationService.evaluate(
                    rerunId.toString(),
                    String.valueOf(row.get("measure_name")),
                    String.valueOf(row.get("version")),
                    String.valueOf(row.get("cql_text")),
                    evaluationDate
            );
        } catch (Exception ex) {
            payload = fallbackPayload(
                    rerunId,
                    String.valueOf(row.get("measure_name")),
                    String.valueOf(row.get("version")),
                    evaluationDate,
                    ex
            );
        }
        runPersistenceService.persistMeasureRun(
                payload,
                "measure",
                null,
                "manual",
                triggerActor,
                requestedScope("MEASURE", (UUID) row.get("measure_id"), scope.scopeId(), null, null, null, evaluationDate, false),
                false
        );
        return buildResponse(
                rerunId,
                RunScopeType.MEASURE.name(),
                payload.measureName() + " " + payload.measureVersion(),
                List.of(payload.measureName())
        );
    }

    private UUID loadCaseIdForRun(UUID sourceRunId, UUID measureVersionId) {
        // Preferred: read caseId from requested_scope_json persisted with the run
        try {
            UUID caseIdFromJson = jdbcTemplate.queryForObject(
                    """
                            SELECT (requested_scope_json->>'caseId')::uuid
                            FROM runs
                            WHERE id = ?
                              AND jsonb_exists(requested_scope_json, 'caseId')
                            """,
                    UUID.class,
                    sourceRunId
            );
            if (caseIdFromJson != null) {
                return caseIdFromJson;
            }
        } catch (EmptyResultDataAccessException ignored) {
            // no caseId in requested_scope_json — fall through to legacy lookup
        }
        // Legacy fallback: look up via last_run_id for older runs without caseId in JSON
        try {
            return jdbcTemplate.queryForObject(
                    """
                            SELECT id
                            FROM cases
                            WHERE last_run_id = ?
                              AND measure_version_id = ?
                            ORDER BY updated_at DESC
                            LIMIT 1
                            """,
                    UUID.class,
                    sourceRunId,
                    measureVersionId
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("No case found for rerun source run " + sourceRunId, ex);
        }
    }

    private ManualRunResponse runMeasureScope(ManualRunRequest request, String actor) {
        if (request.dryRun()) {
            throw new IllegalArgumentException("dryRun is not supported for manual measure runs yet");
        }
        measureService.listMeasures();
        ResolvedMeasureTarget target = resolveMeasureTarget(request);
        LocalDate evaluationDate = effectiveEvaluationDate(request);
        UUID runId = UUID.randomUUID();
        Map<String, Object> requestedScope = requestedScope(
                "MEASURE",
                target.measureId(),
                target.measureVersionId(),
                null,
                null,
                null,
                evaluationDate,
                false
        );
        DemoRunPayload payload;
        try {
            payload = cqlEvaluationService.evaluate(
                    runId.toString(),
                    target.measureName(),
                    target.measureVersion(),
                    target.cqlText(),
                    evaluationDate
            );
        } catch (Exception ex) {
            requestedScope.put("evaluationError", ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
            requestedScope.put("evaluationErrorType", ex.getClass().getSimpleName());
            payload = new DemoRunPayload(
                    runId.toString(),
                    target.measureName(),
                    target.measureVersion(),
                    evaluationDate.toString(),
                    List.of()
            );
        }
        UUID persistedRunId = runPersistenceService.persistMeasureRun(
                payload,
                "measure",
                null,
                "manual",
                actor,
                requestedScope,
                false
        );
        return buildResponse(
                persistedRunId,
                RunScopeType.MEASURE.name(),
                target.measureName() + " " + target.measureVersion(),
                List.of(target.measureName())
        );
    }

    private ManualRunResponse runCaseScope(ManualRunRequest request, String actor) {
        if (request.caseId() == null) {
            throw new IllegalArgumentException("caseId is required for CASE scope");
        }
        if (request.dryRun()) {
            throw new IllegalArgumentException("dryRun is not supported for manual case runs yet");
        }

        var caseDetail = caseFlowService.rerunToVerify(request.caseId(), actor)
                .orElseThrow(() -> new IllegalArgumentException("Case not found: " + request.caseId()));
        UUID runId = caseDetail.lastRunId();
        RunPersistenceService.RunSummaryResponse summary = runPersistenceService.loadRunById(runId)
                .orElseThrow(() -> new IllegalStateException("Verification run not found: " + runId));
        String scopeLabel = caseDetail.measureName() + " case verification";
        return buildResponse(runId, RunScopeType.CASE.name(), scopeLabel, List.of(caseDetail.measureName()), summary);
    }

    private ManualRunResponse buildResponse(UUID runId, String scopeType, String scopeLabel, List<String> measuresExecuted) {
        RunPersistenceService.RunSummaryResponse summary = runPersistenceService.loadRunById(runId).orElse(null);
        return buildResponse(runId, scopeType, scopeLabel, measuresExecuted, summary);
    }

    private ManualRunResponse buildResponse(
            UUID runId,
            String scopeType,
            String scopeLabel,
            List<String> measuresExecuted,
            RunPersistenceService.RunSummaryResponse summary
    ) {
        String status = summary == null ? "COMPLETED" : normalizeStatus(summary.status());
        long totalEvaluated = summary == null ? 0L : summary.totalEvaluated();
        long compliant = summary == null ? 0L : summary.compliantCount();
        long nonCompliant = summary == null ? 0L : summary.nonCompliantCount();
        String message = switch (status) {
            case "PARTIAL_FAILURE" -> "Run completed with partial failures";
            case "FAILED" -> "Run failed";
            default -> "Run completed";
        };
        return new ManualRunResponse(
                runId.toString(),
                scopeType,
                scopeLabel,
                status,
                measuresExecuted.size(),
                totalEvaluated,
                compliant,
                nonCompliant,
                message,
                measuresExecuted
        );
    }

    private DemoRunPayload evaluateMeasureScope(UUID runId, String measureName, UUID measureVersionId, LocalDate evaluationDate) {
        Map<String, Object> row = jdbcTemplate.queryForMap(
                """
                        SELECT cql_text, version
                        FROM measure_versions
                        WHERE id = ?
                        """,
                measureVersionId
        );
        String cqlText = String.valueOf(row.get("cql_text"));
        String measureVersion = String.valueOf(row.get("version"));
        try {
            return cqlEvaluationService.evaluate(
                    runId.toString(),
                    measureName,
                    measureVersion,
                    cqlText,
                    evaluationDate
            );
        } catch (Exception ex) {
            log.error("All-programs CQL evaluation failed for measure {}: {}", measureName, ex.getMessage(), ex);
            return fallbackPayload(runId, measureName, measureVersion, evaluationDate, ex);
        }
    }

    private ResolvedMeasureTarget resolveMeasureTarget(ManualRunRequest request) {
        try {
            if (request.measureVersionId() != null) {
                Map<String, Object> row = jdbcTemplate.queryForMap(
                        """
                                SELECT m.id AS measure_id,
                                       m.name AS measure_name,
                                       mv.id AS measure_version_id,
                                       mv.version AS version,
                                       mv.cql_text AS cql_text
                                FROM measure_versions mv
                                JOIN measures m ON mv.measure_id = m.id
                                WHERE mv.id = ?
                                """,
                        request.measureVersionId()
                );
                return new ResolvedMeasureTarget(
                        (UUID) row.get("measure_id"),
                        (UUID) row.get("measure_version_id"),
                        String.valueOf(row.get("measure_name")),
                        String.valueOf(row.get("version")),
                        String.valueOf(row.get("cql_text"))
                );
            }

            if (request.measureId() != null) {
                Map<String, Object> row = jdbcTemplate.queryForMap(
                        """
                                SELECT m.id AS measure_id,
                                       m.name AS measure_name,
                                       mv.id AS measure_version_id,
                                       mv.version AS version,
                                       mv.cql_text AS cql_text
                                FROM measures m
                                JOIN measure_versions mv ON mv.measure_id = m.id
                                WHERE m.id = ?
                                ORDER BY CASE WHEN mv.status = 'Active' THEN 0 ELSE 1 END, mv.created_at DESC
                                LIMIT 1
                                """,
                        request.measureId()
                );
                return new ResolvedMeasureTarget(
                        (UUID) row.get("measure_id"),
                        (UUID) row.get("measure_version_id"),
                        String.valueOf(row.get("measure_name")),
                        String.valueOf(row.get("version")),
                        String.valueOf(row.get("cql_text"))
                );
            }
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure not found for the requested scope", ex);
        }

        throw new IllegalArgumentException("measureId or measureVersionId is required for MEASURE scope");
    }

    private Map<String, Object> requestedScope(
            String scopeType,
            UUID measureId,
            UUID measureVersionId,
            String site,
            String employeeExternalId,
            UUID caseId,
            LocalDate evaluationDate,
            boolean dryRun
    ) {
        Map<String, Object> requested = new LinkedHashMap<>();
        requested.put("scopeType", scopeType);
        if (measureId != null) {
            requested.put("measureId", measureId.toString());
        }
        if (measureVersionId != null) {
            requested.put("measureVersionId", measureVersionId.toString());
        }
        if (site != null) {
            requested.put("site", site);
        }
        if (employeeExternalId != null) {
            requested.put("employeeExternalId", employeeExternalId);
        }
        if (caseId != null) {
            requested.put("caseId", caseId.toString());
        }
        if (evaluationDate != null) {
            requested.put("evaluationDate", evaluationDate.toString());
        }
        requested.put("dryRun", dryRun);
        return requested;
    }

    private LocalDate effectiveEvaluationDate(ManualRunRequest request) {
        return request.evaluationDate() == null ? LocalDate.now() : request.evaluationDate();
    }

    private String normalizeStatus(String status) {
        if (status == null || status.isBlank()) {
            return "COMPLETED";
        }
        return status.trim().toUpperCase(Locale.ROOT);
    }

    private DemoRunPayload fallbackPayload(
            UUID runId,
            String measureName,
            String measureVersion,
            LocalDate evaluationDate,
            Exception ex
    ) {
        SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId("emp-001");
        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("evaluationError", "CQL engine failure");
        evidence.put("message", ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
        evidence.put("measureName", measureName);
        List<DemoOutcome> outcomes = List.of(new DemoOutcome(
                employee.externalId(),
                employee.name(),
                employee.role(),
                employee.site(),
                "MISSING_DATA",
                "Measure evaluation failed; run continued with failure isolation.",
                evidence
        ));
        return new DemoRunPayload(
                runId.toString(),
                measureName,
                measureVersion == null ? "v1.0" : measureVersion,
                evaluationDate.toString(),
                outcomes
        );
    }

    private List<DemoRunPayload> evaluateForScopeAsync(ManualRunRequest request, UUID runId, LocalDate evaluationDate) {
        return switch (request.scopeType()) {
            case ALL_PROGRAMS -> {
                measureService.listMeasures();
                yield runPersistenceService.loadActiveMeasureScopes().stream()
                        .map(scopeRow -> evaluateMeasureScope(runId, scopeRow.measureName(), scopeRow.measureVersionId(), evaluationDate))
                        .filter(payload -> payload != null)
                        .toList();
            }
            case MEASURE -> {
                ResolvedMeasureTarget target = resolveMeasureTarget(request);
                DemoRunPayload payload;
                try {
                    payload = cqlEvaluationService.evaluate(runId.toString(), target.measureName(), target.measureVersion(), target.cqlText(), evaluationDate);
                } catch (Exception ex) {
                    payload = fallbackPayload(runId, target.measureName(), target.measureVersion(), evaluationDate, ex);
                }
                yield List.of(payload);
            }
            case SITE -> {
                if (request.site() == null || request.site().isBlank()) {
                    throw new IllegalArgumentException("SITE scope requires 'site' field");
                }
                measureService.listMeasures();
                String site = request.site();
                yield runPersistenceService.loadActiveMeasureScopes().stream()
                        .map(scopeRow -> {
                            DemoRunPayload fullPayload = evaluateMeasureScope(runId, scopeRow.measureName(), scopeRow.measureVersionId(), evaluationDate);
                            if (fullPayload == null) return null;
                            List<DemoOutcome> filtered = fullPayload.outcomes().stream()
                                    .filter(o -> site.equalsIgnoreCase(o.site()))
                                    .toList();
                            return new DemoRunPayload(fullPayload.runId(), fullPayload.measureName(), fullPayload.measureVersion(), fullPayload.evaluationDate(), filtered);
                        })
                        .filter(payload -> payload != null && !payload.outcomes().isEmpty())
                        .toList();
            }
            case EMPLOYEE -> {
                if (request.employeeExternalId() == null || request.employeeExternalId().isBlank()) {
                    throw new IllegalArgumentException("EMPLOYEE scope requires 'employeeExternalId' field");
                }
                measureService.listMeasures();
                String empId = request.employeeExternalId();
                yield runPersistenceService.loadActiveMeasureScopes().stream()
                        .map(scopeRow -> {
                            DemoRunPayload fullPayload = evaluateMeasureScope(runId, scopeRow.measureName(), scopeRow.measureVersionId(), evaluationDate);
                            if (fullPayload == null) return null;
                            List<DemoOutcome> filtered = fullPayload.outcomes().stream()
                                    .filter(o -> empId.equals(o.subjectId()))
                                    .toList();
                            return new DemoRunPayload(fullPayload.runId(), fullPayload.measureName(), fullPayload.measureVersion(), fullPayload.evaluationDate(), filtered);
                        })
                        .filter(payload -> payload != null && !payload.outcomes().isEmpty())
                        .toList();
            }
            case CASE -> throw new IllegalArgumentException("CASE scope is handled synchronously");
        };
    }

    private String buildScopeLabel(ManualRunRequest request) {
        return switch (request.scopeType()) {
            case ALL_PROGRAMS -> "All Programs";
            case MEASURE -> "Measure";
            case SITE -> "Site: " + request.site();
            case EMPLOYEE -> "Employee: " + request.employeeExternalId();
            case CASE -> "Case";
        };
    }

    private String buildRequestedScopeJson(ManualRunRequest request) {
        try {
            Map<String, Object> scope = requestedScope(
                    request.scopeType().name(),
                    request.measureId(),
                    request.measureVersionId(),
                    request.site(),
                    request.employeeExternalId(),
                    request.caseId(),
                    effectiveEvaluationDate(request),
                    request.dryRun()
            );
            return objectMapper.writeValueAsString(scope);
        } catch (JsonProcessingException e) {
            return "{}";
        }
    }

    private record ResolvedMeasureTarget(
            UUID measureId,
            UUID measureVersionId,
            String measureName,
            String measureVersion,
            String cqlText
    ) {
    }
}
