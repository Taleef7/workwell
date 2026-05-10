package com.workwell.measure;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Array;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class ValueSetGovernanceService {

    private static final UUID DEMO_VS_AUDIOGRAM = UUID.fromString("a0000001-0000-0000-0000-000000000001");
    private static final UUID DEMO_VS_TB        = UUID.fromString("a0000001-0000-0000-0000-000000000002");
    private static final UUID DEMO_VS_HAZWOPER  = UUID.fromString("a0000001-0000-0000-0000-000000000003");
    private static final UUID DEMO_VS_FLU       = UUID.fromString("a0000001-0000-0000-0000-000000000004");

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public ValueSetGovernanceService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    public ResolveCheckResult resolveCheck(UUID measureId) {
        ensureDemoValueSetLinks();
        UUID measureVersionId = latestMeasureVersionId(measureId);
        String cqlText = getCqlText(measureVersionId);

        String sql = """
                SELECT vs.id, vs.oid, vs.name, vs.version, vs.last_resolved_at,
                       COALESCE(vs.resolution_status, 'UNKNOWN') AS resolution_status,
                       vs.resolution_error,
                       COALESCE(jsonb_array_length(vs.codes_json), 0) AS code_count
                FROM measure_value_set_links l
                JOIN value_sets vs ON vs.id = l.value_set_id
                WHERE l.measure_version_id = ?
                ORDER BY vs.name ASC
                """;

        List<ValueSetCheckItem> items = jdbcTemplate.query(sql, (rs, rowNum) -> {
            String name = rs.getString("name");
            String resolutionStatus = rs.getString("resolution_status");
            int codeCount = rs.getInt("code_count");
            List<String> warnings = new ArrayList<>();
            boolean isBlocker = false;

            if (codeCount == 0) {
                warnings.add("Value set has no codes — activation blocked.");
                isBlocker = true;
            } else if ("UNRESOLVED".equals(resolutionStatus) || "EMPTY".equals(resolutionStatus) || "ERROR".equals(resolutionStatus)) {
                warnings.add("Resolution status is " + resolutionStatus + ".");
                isBlocker = true;
            }
            if (cqlText != null && !cqlText.isBlank()
                    && !cqlText.contains("\"" + name + "\"") && !cqlText.contains("'" + name + "'")) {
                warnings.add("Not referenced in CQL text — may be attached but unused.");
            }

            return new ValueSetCheckItem(
                    (UUID) rs.getObject("id"),
                    name,
                    rs.getString("oid"),
                    rs.getString("version"),
                    resolutionStatus,
                    codeCount,
                    warnings,
                    isBlocker
            );
        }, measureVersionId);

        List<String> blockers = new ArrayList<>();
        List<String> warnings = new ArrayList<>();

        if (items.isEmpty()) {
            warnings.add("No value sets are attached to this measure version.");
        }

        for (ValueSetCheckItem item : items) {
            for (String w : item.warnings()) {
                if (item.blocker() && !w.startsWith("Not referenced")) {
                    blockers.add("[" + item.name() + "] " + w);
                } else {
                    warnings.add("[" + item.name() + "] " + w);
                }
            }
        }

        checkCqlUnattachedReferences(cqlText, items, blockers);

        boolean allResolved = blockers.isEmpty();
        return new ResolveCheckResult(measureId, measureVersionId, allResolved, items, blockers, warnings);
    }

    public ValueSetDiffResponse diff(UUID fromId, UUID toId) {
        ValueSetRaw from = loadRaw(fromId);
        ValueSetRaw to = loadRaw(toId);

        Map<String, CodeEntry> fromMap = indexCodes(from.codes());
        Map<String, CodeEntry> toMap = indexCodes(to.codes());

        List<CodeEntry> added = toMap.entrySet().stream()
                .filter(e -> !fromMap.containsKey(e.getKey()))
                .map(Map.Entry::getValue)
                .collect(Collectors.toList());
        List<CodeEntry> removed = fromMap.entrySet().stream()
                .filter(e -> !toMap.containsKey(e.getKey()))
                .map(Map.Entry::getValue)
                .collect(Collectors.toList());

        List<AffectedMeasure> affected = findAffectedMeasures(Set.of(fromId, toId));
        List<String> warnings = new ArrayList<>();
        if (!added.isEmpty()) warnings.add(added.size() + " code(s) added.");
        if (!removed.isEmpty()) warnings.add(removed.size() + " code(s) removed — existing CQL evaluations may be affected.");

        return new ValueSetDiffResponse(
                fromId.toString(), from.name(), from.version(),
                toId.toString(), to.name(), to.version(),
                added, removed, affected, warnings
        );
    }

    public ValueSetDetail getValueSetDetail(UUID id) {
        String sql = """
                SELECT id, oid, name, version, last_resolved_at,
                       COALESCE(canonical_url, '') AS canonical_url,
                       COALESCE(source, '') AS source,
                       COALESCE(status, 'DRAFT') AS governance_status,
                       COALESCE(resolution_status, 'UNKNOWN') AS resolution_status,
                       COALESCE(resolution_error, '') AS resolution_error,
                       COALESCE(expansion_hash, '') AS expansion_hash,
                       COALESCE(jsonb_array_length(codes_json), 0) AS code_count,
                       COALESCE(code_systems, ARRAY[]::text[]) AS code_systems,
                       codes_json::text AS codes_json_text
                FROM value_sets WHERE id = ?
                """;
        return jdbcTemplate.query(sql, rs -> {
            if (!rs.next()) throw new IllegalArgumentException("Value set not found: " + id);
            return new ValueSetDetail(
                    (UUID) rs.getObject("id"),
                    rs.getString("oid"),
                    rs.getString("name"),
                    rs.getString("version"),
                    toInstant(rs.getObject("last_resolved_at")),
                    rs.getString("canonical_url"),
                    rs.getString("source"),
                    rs.getString("governance_status"),
                    rs.getString("resolution_status"),
                    rs.getString("resolution_error"),
                    rs.getString("expansion_hash"),
                    rs.getInt("code_count"),
                    readSqlArray(rs.getArray("code_systems")),
                    parseCodes(rs.getString("codes_json_text"))
            );
        }, id);
    }

    public List<TerminologyMapping> listTerminologyMappings() {
        String sql = """
                SELECT id, local_code, local_display, local_system,
                       standard_code, standard_display, standard_system,
                       mapping_status, mapping_confidence, reviewed_by, reviewed_at, notes
                FROM terminology_mappings
                ORDER BY mapping_status ASC, local_system ASC, local_code ASC
                """;
        return jdbcTemplate.query(sql, (rs, rowNum) -> new TerminologyMapping(
                (UUID) rs.getObject("id"),
                rs.getString("local_code"),
                rs.getString("local_display"),
                rs.getString("local_system"),
                rs.getString("standard_code"),
                rs.getString("standard_display"),
                rs.getString("standard_system"),
                rs.getString("mapping_status"),
                rs.getObject("mapping_confidence") != null ? rs.getDouble("mapping_confidence") : null,
                rs.getString("reviewed_by"),
                toInstant(rs.getObject("reviewed_at")),
                rs.getString("notes")
        ));
    }

    public TerminologyMapping createTerminologyMapping(
            String localCode, String localDisplay, String localSystem,
            String standardCode, String standardDisplay, String standardSystem,
            String mappingStatus, Double mappingConfidence, String notes
    ) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("""
                INSERT INTO terminology_mappings (id, local_code, local_display, local_system,
                    standard_code, standard_display, standard_system, mapping_status, mapping_confidence, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                id, localCode, localDisplay, localSystem,
                standardCode, standardDisplay, standardSystem,
                mappingStatus != null ? mappingStatus : "PROPOSED",
                mappingConfidence, notes
        );
        return jdbcTemplate.queryForObject("""
                SELECT id, local_code, local_display, local_system,
                       standard_code, standard_display, standard_system,
                       mapping_status, mapping_confidence, reviewed_by, reviewed_at, notes
                FROM terminology_mappings WHERE id = ?
                """, (rs, rowNum) -> new TerminologyMapping(
                (UUID) rs.getObject("id"),
                rs.getString("local_code"),
                rs.getString("local_display"),
                rs.getString("local_system"),
                rs.getString("standard_code"),
                rs.getString("standard_display"),
                rs.getString("standard_system"),
                rs.getString("mapping_status"),
                rs.getObject("mapping_confidence") != null ? rs.getDouble("mapping_confidence") : null,
                rs.getString("reviewed_by"),
                toInstant(rs.getObject("reviewed_at")),
                rs.getString("notes")
        ), id);
    }

    // Private helpers

    private void ensureDemoValueSetLinks() {
        ensureLink("Audiogram", DEMO_VS_AUDIOGRAM);
        ensureLink("TB Surveillance", DEMO_VS_TB);
        ensureLink("HAZWOPER Surveillance", DEMO_VS_HAZWOPER);
        ensureLink("Flu Vaccine", DEMO_VS_FLU);
    }

    private void ensureLink(String measureName, UUID valueSetId) {
        try {
            jdbcTemplate.update("""
                    INSERT INTO measure_value_set_links (measure_version_id, value_set_id)
                    SELECT mv.id, ?
                    FROM measure_versions mv
                    JOIN measures m ON m.id = mv.measure_id
                    WHERE m.name = ?
                    ORDER BY mv.created_at DESC
                    LIMIT 1
                    ON CONFLICT DO NOTHING
                    """, valueSetId, measureName);
        } catch (Exception ignored) {
            // Measure not yet seeded; link will be created on next invocation
        }
    }

    private UUID latestMeasureVersionId(UUID measureId) {
        try {
            return jdbcTemplate.queryForObject(
                    "SELECT id FROM measure_versions WHERE measure_id = ? ORDER BY created_at DESC LIMIT 1",
                    UUID.class, measureId);
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure not found: " + measureId);
        }
    }

    private String getCqlText(UUID measureVersionId) {
        try {
            return jdbcTemplate.queryForObject(
                    "SELECT COALESCE(cql_text, '') FROM measure_versions WHERE id = ?",
                    String.class, measureVersionId);
        } catch (Exception ex) {
            return "";
        }
    }

    private void checkCqlUnattachedReferences(String cqlText, List<ValueSetCheckItem> attached, List<String> blockers) {
        if (cqlText == null || cqlText.isBlank()) return;
        Set<String> attachedNames = attached.stream().map(ValueSetCheckItem::name).collect(Collectors.toSet());
        for (String line : cqlText.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.startsWith("valueset ")) {
                String vsName = extractValueSetName(trimmed);
                if (vsName != null && !attachedNames.contains(vsName)) {
                    blockers.add("CQL references value set \"" + vsName + "\" which is not attached.");
                }
            }
        }
    }

    private String extractValueSetName(String cqlLine) {
        int start = cqlLine.indexOf('"');
        if (start < 0) return null;
        int end = cqlLine.indexOf('"', start + 1);
        if (end < 0) return null;
        return cqlLine.substring(start + 1, end);
    }

    private ValueSetRaw loadRaw(UUID id) {
        String sql = """
                SELECT id, name, version, codes_json::text AS codes_json_text
                FROM value_sets WHERE id = ?
                """;
        return jdbcTemplate.query(sql, rs -> {
            if (!rs.next()) throw new IllegalArgumentException("Value set not found: " + id);
            return new ValueSetRaw(
                    (UUID) rs.getObject("id"),
                    rs.getString("name"),
                    rs.getString("version"),
                    parseCodes(rs.getString("codes_json_text"))
            );
        }, id);
    }

    private Map<String, CodeEntry> indexCodes(List<CodeEntry> codes) {
        Map<String, CodeEntry> map = new HashMap<>();
        for (CodeEntry c : codes) {
            map.put(c.system() + "|" + c.code(), c);
        }
        return map;
    }

    private List<AffectedMeasure> findAffectedMeasures(Set<UUID> valueSetIds) {
        List<AffectedMeasure> result = new ArrayList<>();
        Set<UUID> seen = new HashSet<>();
        for (UUID vsId : valueSetIds) {
            jdbcTemplate.query("""
                    SELECT DISTINCT m.id AS measure_id, m.name AS measure_name, mv.version
                    FROM measure_value_set_links l
                    JOIN measure_versions mv ON mv.id = l.measure_version_id
                    JOIN measures m ON m.id = mv.measure_id
                    WHERE l.value_set_id = ?
                    ORDER BY m.name ASC
                    """, (rs, rowNum) -> {
                UUID measureId = (UUID) rs.getObject("measure_id");
                if (seen.add(measureId)) {
                    result.add(new AffectedMeasure(measureId, rs.getString("measure_name"), rs.getString("version")));
                }
                return null;
            }, vsId);
        }
        return result;
    }

    private List<CodeEntry> parseCodes(String codesJson) {
        if (codesJson == null || codesJson.isBlank() || "[]".equals(codesJson.trim())) return List.of();
        try {
            List<Map<String, Object>> raw = objectMapper.readValue(codesJson, new TypeReference<>() {});
            return raw.stream().map(m -> new CodeEntry(
                    (String) m.getOrDefault("code", ""),
                    (String) m.getOrDefault("display", ""),
                    (String) m.getOrDefault("system", "")
            )).collect(Collectors.toList());
        } catch (Exception ex) {
            return List.of();
        }
    }

    private List<String> readSqlArray(Array array) {
        if (array == null) return List.of();
        try {
            Object[] values = (Object[]) array.getArray();
            return Arrays.stream(values).map(v -> v == null ? "" : v.toString()).collect(Collectors.toList());
        } catch (Exception ex) {
            return List.of();
        }
    }

    private Instant toInstant(Object value) {
        if (value instanceof Timestamp t) return t.toInstant();
        if (value instanceof Instant i) return i;
        return null;
    }

    // Internal raw record
    private record ValueSetRaw(UUID id, String name, String version, List<CodeEntry> codes) {}

    // Public API records

    public record ResolveCheckResult(
            UUID measureId,
            UUID measureVersionId,
            boolean allResolved,
            List<ValueSetCheckItem> valueSets,
            List<String> blockers,
            List<String> warnings
    ) {}

    public record ValueSetCheckItem(
            UUID id,
            String name,
            String oid,
            String version,
            String resolutionStatus,
            int codeCount,
            List<String> warnings,
            boolean blocker
    ) {}

    public record ValueSetDiffResponse(
            String fromId,
            String fromName,
            String fromVersion,
            String toId,
            String toName,
            String toVersion,
            List<CodeEntry> addedCodes,
            List<CodeEntry> removedCodes,
            List<AffectedMeasure> affectedMeasures,
            List<String> warnings
    ) {}

    public record CodeEntry(String code, String display, String system) {}

    public record AffectedMeasure(UUID measureId, String measureName, String version) {}

    public record ValueSetDetail(
            UUID id,
            String oid,
            String name,
            String version,
            Instant lastResolvedAt,
            String canonicalUrl,
            String source,
            String governanceStatus,
            String resolutionStatus,
            String resolutionError,
            String expansionHash,
            int codeCount,
            List<String> codeSystems,
            List<CodeEntry> codes
    ) {}

    public record TerminologyMapping(
            UUID id,
            String localCode,
            String localDisplay,
            String localSystem,
            String standardCode,
            String standardDisplay,
            String standardSystem,
            String mappingStatus,
            Double mappingConfidence,
            String reviewedBy,
            Instant reviewedAt,
            String notes
    ) {}
}
