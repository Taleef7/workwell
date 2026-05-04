package com.workwell.measure;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Array;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class MeasureService {
    private static final String SEEDED_AUDIOGRAM_NAME = "Audiogram";
    private static final String SEEDED_AUDIOGRAM_VERSION = "v1.0";

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public MeasureService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    public List<MeasureCatalogItem> listMeasures() {
        ensureAudiogramSeed();
        ensureTbSeed();

        String sql = """
                SELECT m.id,
                       m.name,
                       m.policy_ref,
                       mv.version,
                       mv.status,
                       m.owner,
                       m.tags,
                       COALESCE(mv.activated_at, mv.created_at, m.updated_at) AS last_updated
                FROM measures m
                JOIN LATERAL (
                    SELECT version, status, activated_at, created_at
                    FROM measure_versions
                    WHERE measure_id = m.id
                    ORDER BY created_at DESC
                    LIMIT 1
                ) mv ON TRUE
                WHERE mv.status = 'Active'
                ORDER BY last_updated DESC, m.name ASC
                """;

        return jdbcTemplate.query(sql, (rs, rowNum) -> new MeasureCatalogItem(
                (UUID) rs.getObject("id"),
                rs.getString("name"),
                rs.getString("policy_ref"),
                rs.getString("version"),
                rs.getString("status"),
                rs.getString("owner"),
                readSqlArray(rs.getArray("tags")),
                toInstant(rs.getObject("last_updated"))
        ));
    }

    public UUID createMeasure(String name, String policyRef, String owner) {
        UUID measureId = UUID.randomUUID();
        UUID measureVersionId = UUID.randomUUID();

        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("description", "");
        spec.put("eligibilityCriteria", Map.of("roleFilter", "", "siteFilter", "", "programEnrollmentText", ""));
        spec.put("exclusions", List.of());
        spec.put("complianceWindow", "");
        spec.put("requiredDataElements", List.of());

        jdbcTemplate.update(
                "INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())",
                ps -> {
                    ps.setObject(1, measureId);
                    ps.setString(2, name);
                    ps.setString(3, policyRef);
                    ps.setString(4, owner);
                    ps.setNull(5, java.sql.Types.ARRAY);
                }
        );

        jdbcTemplate.update(
                "INSERT INTO measure_versions (id, measure_id, version, status, spec_json, cql_text, compile_status, compile_result, change_summary, approved_by, activated_at, created_at) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, ?, ?, NOW())",
                ps -> {
                    ps.setObject(1, measureVersionId);
                    ps.setObject(2, measureId);
                    ps.setString(3, "v1.0");
                    ps.setString(4, "Draft");
                    ps.setString(5, toJson(spec));
                    ps.setString(6, "");
                    ps.setString(7, "ERROR");
                    ps.setString(8, toJson(Map.of("status", "ERROR", "errors", List.of("CQL body is empty or invalid"))));
                    ps.setString(9, "Initial draft");
                    ps.setNull(10, java.sql.Types.VARCHAR);
                    ps.setNull(11, java.sql.Types.TIMESTAMP);
                }
        );

        return measureId;
    }

    public MeasureDetail getMeasure(UUID id) {
        ensureAudiogramSeed();
        ensureTbSeed();

        String sql = """
                SELECT m.id,
                       m.name,
                       m.policy_ref,
                       mv.version,
                       mv.status,
                       mv.compile_status,
                       mv.cql_text,
                       mv.spec_json,
                       m.owner,
                       m.tags,
                       COALESCE(mv.activated_at, mv.created_at, m.updated_at) AS last_updated
                FROM measures m
                JOIN LATERAL (
                    SELECT *
                    FROM measure_versions
                    WHERE measure_id = m.id
                    ORDER BY created_at DESC
                    LIMIT 1
                ) mv ON TRUE
                WHERE m.id = ?
                """;

        return jdbcTemplate.query(sql, rs -> {
            if (!rs.next()) {
                return null;
            }
            Map<String, Object> specJson = readJsonMap(rs.getString("spec_json"));
            Map<String, Object> eligibility = readMap(specJson.get("eligibilityCriteria"));
            List<Map<String, String>> exclusions = readExclusions(specJson.get("exclusions"));
            List<String> requiredDataElements = readStringList(specJson.get("requiredDataElements"));

            return new MeasureDetail(
                    (UUID) rs.getObject("id"),
                    rs.getString("name"),
                    rs.getString("policy_ref"),
                    rs.getString("version"),
                    rs.getString("status"),
                    rs.getString("owner"),
                    readSqlArray(rs.getArray("tags")),
                    toInstant(rs.getObject("last_updated")),
                    stringOrEmpty(specJson.get("description")),
                    new EligibilityCriteria(
                            stringOrEmpty(eligibility.get("roleFilter")),
                            stringOrEmpty(eligibility.get("siteFilter")),
                            stringOrEmpty(eligibility.get("programEnrollmentText"))
                    ),
                    exclusions,
                    stringOrEmpty(specJson.get("complianceWindow")),
                    requiredDataElements,
                    rs.getString("cql_text") == null ? "" : rs.getString("cql_text"),
                    rs.getString("compile_status") == null ? "ERROR" : rs.getString("compile_status")
            );
        }, id);
    }

    public void updateSpec(UUID id, SpecUpdateRequest request) {
        UUID measureVersionId = latestMeasureVersionId(id);

        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("description", request.description());
        spec.put("eligibilityCriteria", Map.of(
                "roleFilter", request.eligibilityCriteria().roleFilter(),
                "siteFilter", request.eligibilityCriteria().siteFilter(),
                "programEnrollmentText", request.eligibilityCriteria().programEnrollmentText()
        ));
        spec.put("exclusions", request.exclusions());
        spec.put("complianceWindow", request.complianceWindow());
        spec.put("requiredDataElements", request.requiredDataElements());

        jdbcTemplate.update(
                "UPDATE measure_versions SET spec_json = ?::jsonb WHERE id = ?",
                toJson(spec),
                measureVersionId
        );
        jdbcTemplate.update("UPDATE measures SET updated_at = NOW() WHERE id = ?", id);
        insertAuditEvent(
                "MEASURE_VERSION_DRAFT_SAVED",
                measureVersionId,
                "system",
                Map.of("field", "spec", "measureId", id.toString())
        );
    }

    public void updateCql(UUID id, String cqlText) {
        UUID measureVersionId = latestMeasureVersionId(id);
        jdbcTemplate.update(
                "UPDATE measure_versions SET cql_text = ? WHERE id = ?",
                cqlText,
                measureVersionId
        );
        jdbcTemplate.update("UPDATE measures SET updated_at = NOW() WHERE id = ?", id);
        insertAuditEvent(
                "MEASURE_VERSION_DRAFT_SAVED",
                measureVersionId,
                "system",
                Map.of("field", "cql", "measureId", id.toString())
        );
    }

    public CompileResponse compileCql(UUID id) {
        UUID measureVersionId = latestMeasureVersionId(id);
        String cqlText = jdbcTemplate.queryForObject(
                "SELECT cql_text FROM measure_versions WHERE id = ?",
                String.class,
                measureVersionId
        );

        CompileResponse response;
        if (cqlText == null || cqlText.trim().isEmpty() || !cqlText.toLowerCase().contains("define")) {
            response = new CompileResponse("ERROR", List.of(), List.of("CQL body is empty or invalid"));
        } else {
            response = new CompileResponse("COMPILED", List.of(), List.of());
        }

        jdbcTemplate.update(
                "UPDATE measure_versions SET compile_status = ?, compile_result = ?::jsonb WHERE id = ?",
                response.status(),
                toJson(Map.of("status", response.status(), "warnings", response.warnings(), "errors", response.errors())),
                measureVersionId
        );
        jdbcTemplate.update("UPDATE measures SET updated_at = NOW() WHERE id = ?", id);
        return response;
    }

    public String transitionStatus(UUID id, String targetStatus) {
        UUID measureVersionId = latestMeasureVersionId(id);
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT status, compile_status FROM measure_versions WHERE id = ?",
                measureVersionId
        );
        String currentStatus = (String) row.get("status");
        String compileStatus = (String) row.get("compile_status");

        boolean allowed = switch (currentStatus + "->" + targetStatus) {
            case "Draft->Approved", "Approved->Active", "Active->Deprecated" -> true;
            default -> false;
        };
        if (!allowed) {
            throw new IllegalArgumentException("Invalid transition from " + currentStatus + " to " + targetStatus);
        }
        if ("Approved".equals(currentStatus) && "Active".equals(targetStatus) && !"COMPILED".equals(compileStatus)) {
            throw new IllegalArgumentException("Measure cannot be activated until CQL compile status is COMPILED");
        }

        jdbcTemplate.update(
                "UPDATE measure_versions SET status = ?, activated_at = CASE WHEN ? = 'Active' THEN NOW() ELSE activated_at END WHERE id = ?",
                targetStatus,
                targetStatus,
                measureVersionId
        );
        jdbcTemplate.update("UPDATE measures SET updated_at = NOW() WHERE id = ?", id);
        insertAuditEvent(
                "MEASURE_VERSION_STATUS_CHANGED",
                measureVersionId,
                "system",
                Map.of(
                        "measureId", id.toString(),
                        "fromStatus", currentStatus,
                        "toStatus", targetStatus
                )
        );
        return targetStatus;
    }

    private UUID latestMeasureVersionId(UUID measureId) {
        try {
            return jdbcTemplate.queryForObject(
                    "SELECT id FROM measure_versions WHERE measure_id = ? ORDER BY created_at DESC LIMIT 1",
                    UUID.class,
                    measureId
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure not found: " + measureId);
        }
    }

    private void ensureAudiogramSeed() {
        UUID measureId;
        try {
            measureId = jdbcTemplate.queryForObject(
                    "SELECT id FROM measures WHERE name = ?",
                    UUID.class,
                    SEEDED_AUDIOGRAM_NAME
            );
        } catch (EmptyResultDataAccessException ex) {
            measureId = UUID.randomUUID();
            jdbcTemplate.update(
                    "INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?::text[], NOW(), NOW())",
                    measureId,
                    SEEDED_AUDIOGRAM_NAME,
                    "OSHA 29 CFR 1910.95",
                    "WorkWell Studio",
                    "{hearing,audiogram}"
            );
        }

        Integer existing = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM measure_versions WHERE measure_id = ?",
                Integer.class,
                measureId
        );
        if (existing != null && existing > 0) {
            return;
        }

        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("description", "Annual audiogram monitoring for noise-exposed employees.");
        spec.put("eligibilityCriteria", Map.of(
                "roleFilter", "Maintenance Tech, Welder",
                "siteFilter", "Plant A, Plant B",
                "programEnrollmentText", "Hearing Conservation Program"
        ));
        spec.put("exclusions", List.of(Map.of("label", "Waiver", "criteriaText", "Valid audiogram waiver on file")));
        spec.put("complianceWindow", "Annual");
        spec.put("requiredDataElements", List.of("Last audiogram date", "Role", "Site", "Program enrollment"));

        jdbcTemplate.update(
                "INSERT INTO measure_versions (id, measure_id, version, status, spec_json, cql_text, compile_status, compile_result, change_summary, approved_by, activated_at, created_at) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, ?, NOW(), NOW())",
                UUID.randomUUID(),
                measureId,
                SEEDED_AUDIOGRAM_VERSION,
                "Active",
                toJson(spec),
                "library Audiogram version '1.0.0'\n\ndefine \"Initial Population\": true",
                "COMPILED",
                toJson(Map.of("status", "COMPILED", "warnings", List.of(), "errors", List.of())),
                "Seeded active demo measure",
                "system"
        );
    }

    private void ensureTbSeed() {
        UUID measureId;
        try {
            measureId = jdbcTemplate.queryForObject(
                    "SELECT id FROM measures WHERE name = ?",
                    UUID.class,
                    "TB Surveillance"
            );
        } catch (EmptyResultDataAccessException ex) {
            measureId = UUID.randomUUID();
            jdbcTemplate.update(
                    "INSERT INTO measures (id, name, policy_ref, owner, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?::text[], NOW(), NOW())",
                    measureId,
                    "TB Surveillance",
                    "CDC Occupational TB Guidance",
                    "WorkWell Studio",
                    "{tb,clinic,surveillance}"
            );
        }

        Integer existing = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM measure_versions WHERE measure_id = ? AND version = ?",
                Integer.class,
                measureId,
                "v1.3"
        );
        if (existing != null && existing > 0) {
            return;
        }

        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("description", "Annual TB surveillance for clinic-based nursing and clinic staff.");
        spec.put("eligibilityCriteria", Map.of(
                "roleFilter", "Nurse, Clinic Staff",
                "siteFilter", "Clinic",
                "programEnrollmentText", "Occupational TB Screening Program"
        ));
        spec.put("exclusions", List.of(Map.of("label", "Medical Exemption", "criteriaText", "Valid exemption documented")));
        spec.put("complianceWindow", "Annual");
        spec.put("requiredDataElements", List.of("Last TB screening date", "Role", "Site", "Exemption status"));

        jdbcTemplate.update(
                "INSERT INTO measure_versions (id, measure_id, version, status, spec_json, cql_text, compile_status, compile_result, change_summary, approved_by, activated_at, created_at) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, ?, NOW(), NOW())",
                UUID.randomUUID(),
                measureId,
                "v1.3",
                "Active",
                toJson(spec),
                "library TbSurveillance version '1.3.0'\n\ndefine \"Initial Population\": true",
                "COMPILED",
                toJson(Map.of("status", "COMPILED", "warnings", List.of(), "errors", List.of())),
                "Seeded active TB measure for demo",
                "system"
        );
    }

    private List<String> readSqlArray(Array array) {
        if (array == null) {
            return List.of();
        }
        try {
            Object[] values = (Object[]) array.getArray();
            List<String> result = new ArrayList<>();
            for (Object value : values) {
                result.add(value == null ? "" : value.toString());
            }
            return result;
        } catch (Exception ex) {
            return List.of();
        }
    }

    private String toJson(Object payload) {
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialise JSON payload", ex);
        }
    }

    private Map<String, Object> readJsonMap(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {
            });
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to parse measure JSON", ex);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readMap(Object value) {
        if (value instanceof Map<?, ?> map) {
            return (Map<String, Object>) map;
        }
        return Map.of();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, String>> readExclusions(Object value) {
        if (!(value instanceof List<?> list)) {
            return List.of();
        }
        List<Map<String, String>> result = new ArrayList<>();
        for (Object entry : list) {
            if (entry instanceof Map<?, ?> map) {
                Map<String, String> exclusion = new LinkedHashMap<>();
                exclusion.put("label", stringOrEmpty(map.get("label")));
                exclusion.put("criteriaText", stringOrEmpty(map.get("criteriaText")));
                result.add(exclusion);
            }
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private List<String> readStringList(Object value) {
        if (!(value instanceof List<?> list)) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (Object item : list) {
            result.add(item == null ? "" : item.toString());
        }
        return result;
    }

    private Instant toInstant(Object value) {
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        return Instant.now();
    }

    private String stringOrEmpty(Object value) {
        return value == null ? "" : value.toString();
    }

    private void insertAuditEvent(String eventType, UUID measureVersionId, String actor, Map<String, Object> payload) {
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_measure_version_id, payload_json) VALUES (?, ?, ?, ?, ?, ?::jsonb)",
                eventType,
                "measure_version",
                measureVersionId,
                actor,
                measureVersionId,
                toJson(payload)
        );
    }

    public record MeasureCatalogItem(
            UUID id,
            String name,
            String policyRef,
            String version,
            String status,
            String owner,
            List<String> tags,
            Instant lastUpdated
    ) {
    }

    public record EligibilityCriteria(
            String roleFilter,
            String siteFilter,
            String programEnrollmentText
    ) {
    }

    public record MeasureDetail(
            UUID id,
            String name,
            String policyRef,
            String version,
            String status,
            String owner,
            List<String> tags,
            Instant lastUpdated,
            String description,
            EligibilityCriteria eligibilityCriteria,
            List<Map<String, String>> exclusions,
            String complianceWindow,
            List<String> requiredDataElements,
            String cqlText,
            String compileStatus
    ) {
    }

    public record SpecUpdateRequest(
            String description,
            EligibilityCriteria eligibilityCriteria,
            List<Map<String, String>> exclusions,
            String complianceWindow,
            List<String> requiredDataElements
    ) {
    }

    public record CompileResponse(
            String status,
            List<String> warnings,
            List<String> errors
    ) {
    }
}
