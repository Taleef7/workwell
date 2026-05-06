package com.workwell.run;

import com.workwell.compile.CqlEvaluationService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.SyntheticEmployeeCatalog;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import com.workwell.web.EvalController.ManualRunResponse;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AllProgramsRunService {
    private static final Logger log = LoggerFactory.getLogger(AllProgramsRunService.class);
    private final RunPersistenceService runPersistenceService;
    private final MeasureService measureService;
    private final JdbcTemplate jdbcTemplate;
    private final CqlEvaluationService cqlEvaluationService;

    public AllProgramsRunService(
            RunPersistenceService runPersistenceService,
            MeasureService measureService,
            JdbcTemplate jdbcTemplate,
            CqlEvaluationService cqlEvaluationService
    ) {
        this.runPersistenceService = runPersistenceService;
        this.measureService = measureService;
        this.jdbcTemplate = jdbcTemplate;
        this.cqlEvaluationService = cqlEvaluationService;
    }

    public ManualRunResponse runAllPrograms(String scopeLabel, String triggerActor) {
        measureService.listMeasures();
        UUID runId = UUID.randomUUID();
        LocalDate evaluationDate = LocalDate.now();
        List<DemoRunPayload> payloads = runPersistenceService.loadActiveMeasureScopes().stream()
                .map(scopeRow -> {
                    var row = jdbcTemplate.queryForMap(
                            "SELECT cql_text, version FROM measure_versions WHERE id = ?",
                            scopeRow.measureVersionId()
                    );
                    String cqlText = (String) row.get("cql_text");
                    String measureVersion = (String) row.get("version");
                    try {
                        return cqlEvaluationService.evaluate(
                                runId.toString(),
                                scopeRow.measureName(),
                                measureVersion,
                                cqlText,
                                evaluationDate
                        );
                    } catch (Exception ex) {
                        log.error("All-programs CQL evaluation failed for measure {}: {}", scopeRow.measureName(), ex.getMessage(), ex);
                        return fallbackPayload(runId, scopeRow.measureName(), measureVersion, evaluationDate, ex);
                    }
                })
                .filter(payload -> payload != null)
                .toList();
        UUID persistedRunId = runPersistenceService.persistAllProgramsRun(runId.toString(), scopeLabel, payloads);
        return new ManualRunResponse(
                persistedRunId.toString(),
                scopeLabel,
                payloads.size(),
                payloads.stream().map(DemoRunPayload::measureName).toList()
        );
    }

    public ManualRunResponse rerunSameScope(UUID sourceRunId, String triggerActor) {
        RunPersistenceService.RerunScope scope = runPersistenceService.loadRerunScope(sourceRunId)
                .orElseThrow(() -> new IllegalArgumentException("Source run not found: " + sourceRunId));
        if ("all_programs".equalsIgnoreCase(scope.scopeType())) {
            return runAllPrograms("All Programs", triggerActor);
        }
        if (!"measure".equalsIgnoreCase(scope.scopeType()) || scope.scopeId() == null) {
            throw new IllegalArgumentException("Unsupported run scope type: " + scope.scopeType());
        }

        var row = jdbcTemplate.queryForMap(
                "SELECT m.name AS measure_name, mv.version AS version, mv.cql_text AS cql_text FROM measure_versions mv JOIN measures m ON m.id = mv.measure_id WHERE mv.id = ?",
                scope.scopeId()
        );
        UUID rerunId = UUID.randomUUID();
        LocalDate evaluationDate = LocalDate.now();
        DemoRunPayload payload;
        try {
            payload = cqlEvaluationService.evaluate(
                    rerunId.toString(),
                    (String) row.get("measure_name"),
                    (String) row.get("version"),
                    (String) row.get("cql_text"),
                    evaluationDate
            );
        } catch (Exception ex) {
            payload = fallbackPayload(
                    rerunId,
                    (String) row.get("measure_name"),
                    (String) row.get("version"),
                    evaluationDate,
                    ex
            );
        }
        runPersistenceService.persistDemoRun(payload);
        return new ManualRunResponse(
                rerunId.toString(),
                scope.site() == null || scope.site().isBlank() ? "Measure Scope" : scope.site(),
                1,
                List.of(payload.measureName())
        );
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
}
