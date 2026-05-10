package com.workwell.measure;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.compile.CqlEvaluationService;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import com.workwell.security.SecurityActor;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class MeasureImpactPreviewService {

    private static final List<String> NON_COMPLIANT_STATUSES = List.of("DUE_SOON", "OVERDUE", "MISSING_DATA");

    private final JdbcTemplate jdbcTemplate;
    private final CqlEvaluationService cqlEvaluationService;
    private final ObjectMapper objectMapper;

    public MeasureImpactPreviewService(
            JdbcTemplate jdbcTemplate,
            CqlEvaluationService cqlEvaluationService,
            ObjectMapper objectMapper
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.cqlEvaluationService = cqlEvaluationService;
        this.objectMapper = objectMapper;
    }

    public ImpactPreviewResponse preview(UUID measureId, ImpactPreviewRequest request) {
        MeasureTarget target = resolveMeasureTarget(measureId, request);
        LocalDate evaluationDate = resolveEvaluationDate(request);

        DemoRunPayload payload;
        List<String> warnings = new ArrayList<>();
        try {
            payload = cqlEvaluationService.evaluate(
                    UUID.randomUUID().toString(),
                    target.measureName(),
                    target.version(),
                    target.cqlText(),
                    evaluationDate
            );
        } catch (Exception ex) {
            warnings.add("CQL evaluation failed: " + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage()));
            writeAuditEvent(target, evaluationDate, 0, Map.of(), warnings);
            return new ImpactPreviewResponse(
                    measureId, target.measureVersionId(), evaluationDate.toString(),
                    0, Map.of(), new CaseImpact(0, 0, 0, 0),
                    List.of(), List.of(), warnings
            );
        }

        List<DemoOutcome> allOutcomes = payload.outcomes();

        // Apply scope filtering (site / employeeExternalId)
        ImpactPreviewScope scope = request == null ? null : request.scope();
        List<DemoOutcome> outcomes = applyScope(allOutcomes, scope);
        if (scope != null && (scope.site() != null || scope.employeeExternalId() != null) && outcomes.isEmpty()) {
            warnings.add("No employees matched the requested scope — preview reflects 0 subjects.");
        }

        Map<String, Integer> outcomeCounts = countOutcomes(outcomes);

        // Estimate case impact by comparing preview outcomes against existing open cases for this period
        CaseImpact caseImpact = estimateCaseImpact(target.measureVersionId(), outcomes, evaluationDate);

        // Site and role breakdown
        List<Map<String, Object>> siteBreakdown = buildSiteBreakdown(outcomes);
        List<Map<String, Object>> roleBreakdown = buildRoleBreakdown(outcomes);

        // Missing data warning
        int missingDataCount = outcomeCounts.getOrDefault("MISSING_DATA", 0);
        if (missingDataCount > 0) {
            warnings.add(missingDataCount + " employee(s) would have MISSING_DATA outcome — required exam records may be absent.");
        }

        writeAuditEvent(target, evaluationDate, outcomes.size(), outcomeCounts, warnings);

        return new ImpactPreviewResponse(
                measureId, target.measureVersionId(), evaluationDate.toString(),
                outcomes.size(), outcomeCounts, caseImpact,
                siteBreakdown, roleBreakdown, warnings
        );

    }

    private MeasureTarget resolveMeasureTarget(UUID measureId, ImpactPreviewRequest request) {
        try {
            if (request != null && request.measureVersionId() != null) {
                Map<String, Object> row = jdbcTemplate.queryForMap(
                        """
                        SELECT m.id AS measure_id, m.name AS measure_name,
                               mv.id AS measure_version_id, mv.version, mv.cql_text
                        FROM measure_versions mv
                        JOIN measures m ON mv.measure_id = m.id
                        WHERE mv.id = ? AND mv.measure_id = ?
                        """,
                        request.measureVersionId(), measureId
                );
                return new MeasureTarget(
                        (UUID) row.get("measure_id"),
                        (UUID) row.get("measure_version_id"),
                        (String) row.get("measure_name"),
                        (String) row.get("version"),
                        (String) row.get("cql_text")
                );
            }
            // Default: latest version
            Map<String, Object> row = jdbcTemplate.queryForMap(
                    """
                    SELECT m.id AS measure_id, m.name AS measure_name,
                           mv.id AS measure_version_id, mv.version, mv.cql_text
                    FROM measures m
                    JOIN LATERAL (
                        SELECT id, version, cql_text, status, created_at
                        FROM measure_versions WHERE measure_id = m.id
                        ORDER BY created_at DESC LIMIT 1
                    ) mv ON TRUE
                    WHERE m.id = ?
                    """,
                    measureId
            );
            return new MeasureTarget(
                    (UUID) row.get("measure_id"),
                    (UUID) row.get("measure_version_id"),
                    (String) row.get("measure_name"),
                    (String) row.get("version"),
                    (String) row.get("cql_text")
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure not found: " + measureId);
        }
    }

    private LocalDate resolveEvaluationDate(ImpactPreviewRequest request) {
        if (request != null && request.evaluationDate() != null && !request.evaluationDate().isBlank()) {
            try {
                return LocalDate.parse(request.evaluationDate());
            } catch (Exception ex) {
                throw new IllegalArgumentException("Invalid evaluationDate format: '" + request.evaluationDate() + "' — expected YYYY-MM-DD");
            }
        }
        return LocalDate.now();
    }

    private Map<String, Integer> countOutcomes(List<DemoOutcome> outcomes) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        counts.put("COMPLIANT", 0);
        counts.put("DUE_SOON", 0);
        counts.put("OVERDUE", 0);
        counts.put("MISSING_DATA", 0);
        counts.put("EXCLUDED", 0);
        for (DemoOutcome outcome : outcomes) {
            String status = outcome.outcome() == null ? "MISSING_DATA" : outcome.outcome().toUpperCase();
            counts.merge(status, 1, Integer::sum);
        }
        return counts;
    }

    private CaseImpact estimateCaseImpact(UUID measureVersionId, List<DemoOutcome> outcomes, LocalDate evaluationDate) {
        // Query existing open cases for this measure version and evaluation period
        String evalPeriod = evaluationDate.toString();
        List<String> openCaseSubjectIds;
        try {
            openCaseSubjectIds = jdbcTemplate.query(
                    """
                    SELECT e.external_id
                    FROM cases c
                    JOIN employees e ON e.id = c.employee_id
                    WHERE c.measure_version_id = ?
                      AND c.evaluation_period = ?
                      AND c.status != 'RESOLVED'
                    """,
                    (rs, i) -> rs.getString("external_id"),
                    measureVersionId,
                    evalPeriod
            );
        } catch (Exception ex) {
            openCaseSubjectIds = List.of();
        }

        int wouldCreate = 0;
        int wouldUpdate = 0;
        int wouldClose = 0;
        int wouldExclude = 0;

        for (DemoOutcome outcome : outcomes) {
            String status = outcome.outcome() == null ? "MISSING_DATA" : outcome.outcome().toUpperCase();
            boolean hasExistingCase = openCaseSubjectIds.contains(outcome.subjectId());

            if (NON_COMPLIANT_STATUSES.contains(status)) {
                if (hasExistingCase) {
                    wouldUpdate++;
                } else {
                    wouldCreate++;
                }
            } else if ("COMPLIANT".equals(status)) {
                if (hasExistingCase) wouldClose++;
            } else if ("EXCLUDED".equals(status)) {
                if (hasExistingCase) wouldExclude++;
            }
        }

        return new CaseImpact(wouldCreate, wouldUpdate, wouldClose, wouldExclude);
    }

    private List<DemoOutcome> applyScope(List<DemoOutcome> outcomes, ImpactPreviewScope scope) {
        if (scope == null) return outcomes;
        return outcomes.stream()
                .filter(o -> scope.site() == null || scope.site().equalsIgnoreCase(o.site()))
                .filter(o -> scope.employeeExternalId() == null || scope.employeeExternalId().equalsIgnoreCase(o.subjectId()))
                .toList();
    }

    private List<Map<String, Object>> buildSiteBreakdown(List<DemoOutcome> outcomes) {
        Map<String, Map<String, Integer>> bySite = new LinkedHashMap<>();
        for (DemoOutcome outcome : outcomes) {
            String site = outcome.site() == null ? "Unknown" : outcome.site();
            String status = outcome.outcome() == null ? "MISSING_DATA" : outcome.outcome().toUpperCase();
            bySite.computeIfAbsent(site, k -> new HashMap<>()).merge(status, 1, Integer::sum);
        }
        List<Map<String, Object>> result = new ArrayList<>();
        bySite.forEach((site, counts) -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("site", site);
            row.putAll(counts);
            result.add(row);
        });
        return result;
    }

    private List<Map<String, Object>> buildRoleBreakdown(List<DemoOutcome> outcomes) {
        Map<String, Map<String, Integer>> byRole = new LinkedHashMap<>();
        for (DemoOutcome outcome : outcomes) {
            String role = outcome.role() == null ? "Unknown" : outcome.role();
            String status = outcome.outcome() == null ? "MISSING_DATA" : outcome.outcome().toUpperCase();
            byRole.computeIfAbsent(role, k -> new HashMap<>()).merge(status, 1, Integer::sum);
        }
        List<Map<String, Object>> result = new ArrayList<>();
        byRole.forEach((role, counts) -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("role", role);
            row.putAll(counts);
            result.add(row);
        });
        return result;
    }

    private void writeAuditEvent(
            MeasureTarget target,
            LocalDate evaluationDate,
            int populationEvaluated,
            Map<String, Integer> outcomeCounts,
            List<String> warnings
    ) {
        String actor = SecurityActor.currentActorOr("system");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("measureId", target.measureId().toString());
        payload.put("measureVersionId", target.measureVersionId().toString());
        payload.put("measureName", target.measureName());
        payload.put("version", target.version());
        payload.put("evaluationDate", evaluationDate.toString());
        payload.put("populationEvaluated", populationEvaluated);
        payload.put("outcomeCounts", outcomeCounts);
        payload.put("warningCount", warnings.size());
        payload.put("dryRun", true);
        try {
            jdbcTemplate.update(
                    "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_measure_version_id, payload_json) VALUES (?, ?, ?, ?, ?, ?::jsonb)",
                    "MEASURE_IMPACT_PREVIEWED",
                    "measure_version",
                    target.measureVersionId(),
                    actor,
                    target.measureVersionId(),
                    objectMapper.writeValueAsString(payload)
            );
        } catch (JsonProcessingException ex) {
            // non-fatal — preview result is still returned
        }
    }

    // --- records ---

    private record MeasureTarget(UUID measureId, UUID measureVersionId, String measureName, String version, String cqlText) {}

    public record ImpactPreviewRequest(UUID measureVersionId, String evaluationDate, ImpactPreviewScope scope) {}

    public record ImpactPreviewScope(String site, String employeeExternalId) {}

    public record CaseImpact(int wouldCreate, int wouldUpdate, int wouldClose, int wouldExclude) {}

    public record ImpactPreviewResponse(
            UUID measureId,
            UUID measureVersionId,
            String evaluationDate,
            int populationEvaluated,
            Map<String, Integer> outcomeCounts,
            CaseImpact caseImpact,
            List<Map<String, Object>> siteBreakdown,
            List<Map<String, Object>> roleBreakdown,
            List<String> warnings
    ) {}
}
