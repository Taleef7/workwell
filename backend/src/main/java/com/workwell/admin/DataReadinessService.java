package com.workwell.admin;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class DataReadinessService {

    // Longest-match-first: more specific phrases before general keywords
    private static final Map<String, String> LABEL_TO_CANONICAL;
    static {
        var m = new LinkedHashMap<String, String>();
        m.put("last audiogram date",       "procedure.audiogram");
        m.put("last tb screening date",    "procedure.tbScreen");
        m.put("last surveillance exam date", "procedure.hazwoperExam");
        m.put("last flu vaccine date",     "procedure.fluVaccine");
        m.put("contraindication status",   "waiver.flu");
        m.put("exemption status",          "waiver.medical");
        m.put("program enrollment",        "programEnrollment.hearingConservation");
        m.put("current season",            "policy.fluSeason");
        m.put("audiogram",                 "procedure.audiogram");
        m.put("tb screening",              "procedure.tbScreen");
        m.put("surveillance exam",         "procedure.hazwoperExam");
        m.put("flu vaccine",               "procedure.fluVaccine");
        m.put("contraindication",          "waiver.flu");
        m.put("exemption",                 "waiver.medical");
        m.put("enrollment",               "programEnrollment.hearingConservation");
        m.put("season",                    "policy.fluSeason");
        m.put("role",                      "employee.role");
        m.put("site",                      "employee.site");
        LABEL_TO_CANONICAL = Collections.unmodifiableMap(m);
    }

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public DataReadinessService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    public List<DataElementMapping> listMappings() {
        return jdbcTemplate.query(
                """
                SELECT d.id, d.source_id, s.display_name AS source_display_name, s.source_type,
                       d.canonical_element, d.source_field, d.fhir_resource_type, d.fhir_path,
                       d.code_system, d.mapping_status, d.last_validated_at, d.notes
                FROM data_element_mappings d
                JOIN integration_sources s ON s.id = d.source_id
                ORDER BY d.source_id, d.canonical_element
                """,
                (rs, i) -> new DataElementMapping(
                        (UUID) rs.getObject("id"),
                        rs.getString("source_id"),
                        rs.getString("source_display_name"),
                        rs.getString("source_type"),
                        rs.getString("canonical_element"),
                        rs.getString("source_field"),
                        rs.getString("fhir_resource_type"),
                        rs.getString("fhir_path"),
                        rs.getString("code_system"),
                        rs.getString("mapping_status"),
                        rs.getTimestamp("last_validated_at") == null ? null
                                : rs.getTimestamp("last_validated_at").toInstant(),
                        rs.getString("notes")
                )
        );
    }

    public List<DataElementMapping> validateMappings() {
        // Sync integration_health status into integration_sources
        jdbcTemplate.update("""
                UPDATE integration_sources s
                SET status = CASE
                    WHEN ih.status = 'healthy'  THEN 'HEALTHY'
                    WHEN ih.status = 'degraded' THEN 'DEGRADED'
                    ELSE 'UNKNOWN'
                END,
                last_sync_at = ih.last_sync_at
                FROM integration_health ih
                WHERE s.id = ih.id
                """);

        // Mark mappings STALE when source is degraded; restore when healthy
        jdbcTemplate.update("""
                UPDATE data_element_mappings d
                SET mapping_status = CASE
                    WHEN s.status = 'DEGRADED' THEN 'STALE'
                    WHEN s.status = 'HEALTHY' AND d.mapping_status = 'STALE' THEN 'MAPPED'
                    ELSE d.mapping_status
                END,
                last_validated_at = NOW()
                FROM integration_sources s
                WHERE d.source_id = s.id
                """);

        return listMappings();
    }

    public DataReadinessResponse computeReadiness(UUID measureId) {
        List<Map<String, Object>> rows = jdbcTemplate.query(
                """
                SELECT mv.id AS version_id, mv.spec_json::text AS spec_json
                FROM measure_versions mv
                WHERE mv.measure_id = ?
                ORDER BY mv.created_at DESC
                LIMIT 1
                """,
                (rs, i) -> {
                    var row = new LinkedHashMap<String, Object>();
                    row.put("version_id", rs.getObject("version_id"));
                    row.put("spec_json", rs.getString("spec_json"));
                    return row;
                },
                measureId
        );

        if (rows.isEmpty()) {
            throw new IllegalArgumentException("Measure not found: " + measureId);
        }

        UUID measureVersionId = (UUID) rows.get(0).get("version_id");
        List<String> specElements = parseRequiredElements((String) rows.get(0).get("spec_json"));

        Map<String, DataElementMapping> canonicalToMapping = new LinkedHashMap<>();
        for (DataElementMapping dm : listMappings()) {
            canonicalToMapping.put(dm.canonicalElement(), dm);
        }

        double missingnessRate = computeMissingnessRate(measureVersionId);
        List<String> sampleMissing = findSampleMissingEmployees(measureVersionId);

        List<RequiredElementReadiness> elementReadiness = new ArrayList<>();
        List<String> blockers = new ArrayList<>();
        List<String> warnings = new ArrayList<>();

        for (String label : specElements) {
            String canonical = resolveCanonical(label);
            DataElementMapping mapping = canonical != null ? canonicalToMapping.get(canonical) : null;

            String mappingStatus = mapping != null ? mapping.mappingStatus() : "UNMAPPED";
            String sourceId = mapping != null ? mapping.sourceId() : null;
            String freshnessStatus = computeFreshness(sourceId);

            boolean clinical = isClinicalElement(canonical);
            double elementMissingness = clinical ? missingnessRate : 0.0;
            List<String> elementSampleMissing = clinical ? sampleMissing : List.of();

            elementReadiness.add(new RequiredElementReadiness(
                    canonical != null ? canonical : label.toLowerCase().replace(' ', '.'),
                    label,
                    sourceId,
                    mappingStatus,
                    freshnessStatus,
                    elementMissingness,
                    elementSampleMissing
            ));

            if ("UNMAPPED".equals(mappingStatus)) {
                blockers.add("Required element '" + label + "' has no source mapping.");
            } else if ("ERROR".equals(mappingStatus)) {
                blockers.add("Required element '" + label + "' mapping is in ERROR state.");
            } else if ("STALE".equals(mappingStatus)
                    || "STALE".equals(freshnessStatus)
                    || "VERY_STALE".equals(freshnessStatus)) {
                warnings.add("Source data for '" + label + "' may be stale.");
            }
        }

        if (missingnessRate > 0.05) {
            warnings.add(String.format(
                    "%.0f%% of evaluated employees have missing data outcomes for this measure.",
                    missingnessRate * 100));
        }

        String overallStatus = !blockers.isEmpty() ? "NOT_READY"
                : !warnings.isEmpty() ? "READY_WITH_WARNINGS"
                : "READY";

        return new DataReadinessResponse(overallStatus, elementReadiness, blockers, warnings);
    }

    private List<String> parseRequiredElements(String specJson) {
        try {
            Map<String, Object> spec = objectMapper.readValue(specJson, new TypeReference<>() {});
            Object raw = spec.get("requiredDataElements");
            if (raw instanceof List<?> list) {
                return list.stream().map(Object::toString).toList();
            }
        } catch (Exception ignored) {
        }
        return List.of();
    }

    private String resolveCanonical(String label) {
        if (label == null) return null;
        String lower = label.toLowerCase().trim();
        for (Map.Entry<String, String> entry : LABEL_TO_CANONICAL.entrySet()) {
            if (lower.contains(entry.getKey())) {
                return entry.getValue();
            }
        }
        return null;
    }

    private String computeFreshness(String sourceId) {
        if (sourceId == null) return "UNKNOWN";
        List<Instant> results = jdbcTemplate.query(
                "SELECT last_sync_at FROM integration_health WHERE id = ?",
                (rs, i) -> rs.getTimestamp("last_sync_at") == null
                        ? null
                        : rs.getTimestamp("last_sync_at").toInstant(),
                sourceId
        );
        if (results.isEmpty()) return "UNKNOWN";
        Instant lastSync = results.get(0);
        if (lastSync == null) {
            return ("hris".equals(sourceId) || "fhir".equals(sourceId)) ? "FRESH" : "UNKNOWN";
        }
        long hoursAgo = ChronoUnit.HOURS.between(lastSync, Instant.now());
        if (hoursAgo <= 24) return "FRESH";
        if (hoursAgo <= 168) return "STALE";
        return "VERY_STALE";
    }

    private double computeMissingnessRate(UUID measureVersionId) {
        try {
            List<int[]> results = jdbcTemplate.query(
                    """
                    SELECT
                        COUNT(*) FILTER (WHERE status = 'MISSING_DATA') AS missing_count,
                        COUNT(*) AS total_count
                    FROM outcomes
                    WHERE measure_version_id = ?
                    """,
                    (rs, i) -> new int[]{rs.getInt("missing_count"), rs.getInt("total_count")},
                    measureVersionId
            );
            if (results.isEmpty() || results.get(0)[1] == 0) return 0.0;
            return (double) results.get(0)[0] / results.get(0)[1];
        } catch (Exception ignored) {
            return 0.0;
        }
    }

    private List<String> findSampleMissingEmployees(UUID measureVersionId) {
        try {
            return jdbcTemplate.query(
                    """
                    SELECT DISTINCT e.external_id
                    FROM outcomes o
                    JOIN employees e ON e.id = o.employee_id
                    WHERE o.measure_version_id = ? AND o.status = 'MISSING_DATA'
                    ORDER BY e.external_id
                    LIMIT 3
                    """,
                    (rs, i) -> rs.getString("external_id"),
                    measureVersionId
            );
        } catch (Exception ignored) {
            return List.of();
        }
    }

    private boolean isClinicalElement(String canonical) {
        return canonical != null
                && (canonical.startsWith("procedure.") || canonical.startsWith("policy."));
    }

    public record DataElementMapping(
            UUID id,
            String sourceId,
            String sourceDisplayName,
            String sourceType,
            String canonicalElement,
            String sourceField,
            String fhirResourceType,
            String fhirPath,
            String codeSystem,
            String mappingStatus,
            Instant lastValidatedAt,
            String notes
    ) {}

    public record RequiredElementReadiness(
            String canonicalElement,
            String label,
            String sourceId,
            String mappingStatus,
            String freshnessStatus,
            double missingnessRate,
            List<String> sampleMissingEmployees
    ) {}

    public record DataReadinessResponse(
            String overallStatus,
            List<RequiredElementReadiness> requiredElements,
            List<String> blockers,
            List<String> warnings
    ) {}
}
