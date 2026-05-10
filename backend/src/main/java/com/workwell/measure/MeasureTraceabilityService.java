package com.workwell.measure;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class MeasureTraceabilityService {

    private static final Pattern DEFINE_PATTERN = Pattern.compile(
            "define\\s+\"([^\"]+)\"\\s*:", Pattern.MULTILINE | Pattern.CASE_INSENSITIVE
    );

    private static final List<String> KNOWN_EVIDENCE_KEYS = List.of(
            "last_exam_date", "compliance_window_days", "days_overdue",
            "role_eligible", "site_eligible", "waiver_status", "outcome_status"
    );

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public MeasureTraceabilityService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    public TraceabilityResponse generate(UUID measureId) {
        MeasureVersionData data = loadMeasureVersionData(measureId);
        List<CqlDefine> defines = parseCqlDefines(data.cqlText());
        List<TraceabilityRow> rows = buildRows(data, defines);
        List<TraceabilityGap> gaps = buildGaps(data, defines);
        return new TraceabilityResponse(
                data.measureId(), data.measureVersionId(), data.measureName(),
                data.version(), rows, gaps
        );
    }

    private MeasureVersionData loadMeasureVersionData(UUID measureId) {
        try {
            Map<String, Object> row = jdbcTemplate.queryForMap(
                    """
                    SELECT m.id AS measure_id, m.name AS measure_name, m.policy_ref,
                           mv.id AS measure_version_id, mv.version, mv.status,
                           mv.cql_text, mv.compile_status,
                           mv.spec_json::text AS spec_json_text
                    FROM measures m
                    JOIN LATERAL (
                        SELECT * FROM measure_versions WHERE measure_id = m.id
                        ORDER BY created_at DESC LIMIT 1
                    ) mv ON TRUE
                    WHERE m.id = ?
                    """,
                    measureId
            );

            String specJson = (String) row.get("spec_json_text");
            Map<String, Object> spec = parseJsonMap(specJson);

            List<ValueSetRef> valueSets = loadAttachedValueSets((UUID) row.get("measure_version_id"));

            return new MeasureVersionData(
                    (UUID) row.get("measure_id"),
                    (UUID) row.get("measure_version_id"),
                    (String) row.get("measure_name"),
                    (String) row.get("version"),
                    (String) row.get("policy_ref"),
                    (String) row.get("cql_text"),
                    (String) row.get("compile_status"),
                    spec,
                    valueSets
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure not found: " + measureId);
        }
    }

    private List<ValueSetRef> loadAttachedValueSets(UUID measureVersionId) {
        return jdbcTemplate.query(
                """
                SELECT vs.name, vs.oid, vs.version
                FROM measure_value_set_links l
                JOIN value_sets vs ON vs.id = l.value_set_id
                WHERE l.measure_version_id = ?
                ORDER BY vs.name ASC
                """,
                (rs, i) -> new ValueSetRef(rs.getString("name"), rs.getString("oid"), rs.getString("version")),
                measureVersionId
        );
    }

    private List<CqlDefine> parseCqlDefines(String cqlText) {
        if (cqlText == null || cqlText.isBlank()) return List.of();
        List<CqlDefine> result = new ArrayList<>();
        Matcher m = DEFINE_PATTERN.matcher(cqlText);
        int[] positions = new int[1024];
        String[] names = new String[1024];
        int count = 0;
        while (m.find() && count < 1024) {
            positions[count] = m.start();
            names[count] = m.group(1);
            count++;
        }
        for (int i = 0; i < count; i++) {
            int start = positions[i];
            int end = i + 1 < count ? positions[i + 1] : cqlText.length();
            String snippet = cqlText.substring(start, Math.min(start + 200, end)).trim();
            result.add(new CqlDefine(names[i], snippet));
        }
        return result;
    }

    private List<TraceabilityRow> buildRows(MeasureVersionData data, List<CqlDefine> defines) {
        List<TraceabilityRow> rows = new ArrayList<>();
        Map<String, Object> spec = data.spec();

        String policyCitation = data.policyRef();
        List<String> requiredDataElements = readStringList(spec.get("requiredDataElements"));
        List<Map<String, String>> exclusions = readExclusions(spec.get("exclusions"));
        String complianceWindow = stringOrEmpty(spec.get("complianceWindow"));
        Map<String, Object> eligibility = readMap(spec.get("eligibilityCriteria"));

        // Row: eligibility
        String enrollmentText = stringOrEmpty(eligibility.get("programEnrollmentText"));
        String roleFilter = stringOrEmpty(eligibility.get("roleFilter"));
        String siteFilter = stringOrEmpty(eligibility.get("siteFilter"));
        String eligibilitySpecValue = (enrollmentText.isEmpty() ? "" : enrollmentText)
                + (roleFilter.isEmpty() ? "" : "; roles: " + roleFilter)
                + (siteFilter.isEmpty() ? "" : "; sites: " + siteFilter);
        CqlDefine eligibilityDefine = findDefineByKeywords(defines, "program", "enrolled", "initial population", "eligib");
        rows.add(new TraceabilityRow(
                policyCitation,
                "Population eligibility for program",
                "eligibilityCriteria",
                eligibilitySpecValue,
                eligibilityDefine != null ? eligibilityDefine.name() : "",
                eligibilityDefine != null ? eligibilityDefine.snippet() : "",
                data.valueSets(),
                requiredDataElements,
                readTestFixtures(data.spec()),
                List.of("role_eligible", "site_eligible")
        ));

        // Row: exclusion
        if (!exclusions.isEmpty()) {
            String exclusionLabel = exclusions.stream()
                    .map(e -> e.getOrDefault("label", ""))
                    .filter(l -> !l.isEmpty())
                    .findFirst().orElse("exclusion");
            String exclusionCriteria = exclusions.stream()
                    .map(e -> e.getOrDefault("criteriaText", ""))
                    .filter(c -> !c.isEmpty())
                    .findFirst().orElse("");
            CqlDefine exclusionDefine = findDefineByKeywords(defines, "waiver", "exempt", "exclusion");
            rows.add(new TraceabilityRow(
                    policyCitation,
                    "Exclusion: " + exclusionLabel,
                    "exclusions",
                    exclusionCriteria,
                    exclusionDefine != null ? exclusionDefine.name() : "",
                    exclusionDefine != null ? exclusionDefine.snippet() : "",
                    data.valueSets(),
                    List.of(),
                    List.of(),
                    List.of("waiver_status")
            ));
        }

        // Row: compliance window / recency check
        CqlDefine recencyDefine = findDefineByKeywords(defines, "most recent", "last", "days since", "date");
        CqlDefine daysDefine = findDefineByKeywords(defines, "days since", "days over");
        CqlDefine outcomeDefine = findDefineByKeywords(defines, "outcome status", "outcome");
        rows.add(new TraceabilityRow(
                policyCitation,
                "Compliance window: " + (complianceWindow.isEmpty() ? "see spec" : complianceWindow),
                "complianceWindow",
                complianceWindow,
                recencyDefine != null ? recencyDefine.name() : (outcomeDefine != null ? outcomeDefine.name() : ""),
                recencyDefine != null ? recencyDefine.snippet() : (outcomeDefine != null ? outcomeDefine.snippet() : ""),
                data.valueSets(),
                requiredDataElements,
                readTestFixtures(data.spec()),
                List.of("last_exam_date", "compliance_window_days", "days_overdue", "outcome_status")
        ));

        // Row: days/age calculation if present
        if (daysDefine != null && !daysDefine.equals(recencyDefine)) {
            rows.add(new TraceabilityRow(
                    policyCitation,
                    "Days elapsed since last exam",
                    "complianceWindow",
                    "Threshold: " + complianceWindow,
                    daysDefine.name(),
                    daysDefine.snippet(),
                    List.of(),
                    List.of("Procedure.performedDateTime"),
                    List.of(),
                    List.of("days_overdue", "compliance_window_days")
            ));
        }

        return rows;
    }

    private List<TraceabilityGap> buildGaps(MeasureVersionData data, List<CqlDefine> defines) {
        List<TraceabilityGap> gaps = new ArrayList<>();

        // Missing policy citation
        if (data.policyRef() == null || data.policyRef().isBlank()) {
            gaps.add(new TraceabilityGap("WARN", "No policy citation set. Add a policy reference in the Spec tab."));
        }

        // Compile status not compiled
        String compileStatus = data.compileStatus();
        if (compileStatus == null || (!compileStatus.equalsIgnoreCase("COMPILED") && !compileStatus.equalsIgnoreCase("WARNINGS"))) {
            gaps.add(new TraceabilityGap("ERROR", "CQL compile status is " + (compileStatus == null ? "UNKNOWN" : compileStatus) + ". CQL must be compiled before activation."));
        }

        // No test fixtures
        List<TestFixtureRef> fixtures = readTestFixtures(data.spec());
        if (fixtures.isEmpty()) {
            gaps.add(new TraceabilityGap("WARN", "No test fixtures defined. Add at least one test fixture covering each expected outcome."));
        } else {
            // Check coverage of MISSING_DATA and EXCLUDED
            boolean hasMissingData = fixtures.stream().anyMatch(f -> "MISSING_DATA".equalsIgnoreCase(f.expectedOutcome()));
            boolean hasExcluded = fixtures.stream().anyMatch(f -> "EXCLUDED".equalsIgnoreCase(f.expectedOutcome()));
            if (!hasMissingData) {
                gaps.add(new TraceabilityGap("WARN", "No test fixture covers MISSING_DATA outcome. Consider adding one for traceability completeness."));
            }
            if (!hasExcluded) {
                gaps.add(new TraceabilityGap("WARN", "No test fixture covers EXCLUDED outcome. Consider adding one for traceability completeness."));
            }
        }

        // No value sets
        if (data.valueSets().isEmpty()) {
            gaps.add(new TraceabilityGap("WARN", "No value sets attached to this measure version. Attach value sets referenced in the CQL."));
        } else {
            // Check if value sets are referenced in CQL
            String cqlLower = data.cqlText() == null ? "" : data.cqlText().toLowerCase();
            for (ValueSetRef vs : data.valueSets()) {
                String vsNameLower = vs.name() == null ? "" : vs.name().toLowerCase();
                // Check by name keywords (simple heuristic)
                if (!vsNameLower.isBlank()) {
                    String firstWord = vsNameLower.split("\\s+")[0];
                    if (firstWord.length() > 3 && !cqlLower.contains(firstWord)) {
                        gaps.add(new TraceabilityGap("WARN",
                                "Value set '" + vs.name() + "' may not be referenced in CQL. Verify the CQL uses this value set by name or OID."));
                    }
                }
            }
        }

        // No CQL defines found
        if (defines.isEmpty() && data.cqlText() != null && !data.cqlText().isBlank()) {
            gaps.add(new TraceabilityGap("WARN", "No CQL defines found. Ensure CQL uses define \"Name\": syntax."));
        }

        return gaps;
    }

    private CqlDefine findDefineByKeywords(List<CqlDefine> defines, String... keywords) {
        for (String keyword : keywords) {
            for (CqlDefine define : defines) {
                if (define.name().toLowerCase().contains(keyword.toLowerCase())) {
                    return define;
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readMap(Object value) {
        if (value instanceof Map<?, ?> map) return (Map<String, Object>) map;
        return Map.of();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, String>> readExclusions(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        List<Map<String, String>> result = new ArrayList<>();
        for (Object entry : list) {
            if (entry instanceof Map<?, ?> map) {
                Map<String, String> ex = new LinkedHashMap<>();
                ex.put("label", stringOrEmpty(map.get("label")));
                ex.put("criteriaText", stringOrEmpty(map.get("criteriaText")));
                result.add(ex);
            }
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private List<String> readStringList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        return list.stream().map(item -> item == null ? "" : item.toString()).toList();
    }

    private List<TestFixtureRef> readTestFixtures(Map<String, Object> spec) {
        Object raw = spec.get("testFixtures");
        if (!(raw instanceof List<?> list)) return List.of();
        List<TestFixtureRef> result = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                result.add(new TestFixtureRef(
                        stringOrEmpty(map.get("fixtureName")),
                        stringOrEmpty(map.get("expectedOutcome"))
                ));
            }
        }
        return result;
    }

    private Map<String, Object> parseJsonMap(String json) {
        if (json == null || json.isBlank()) return Map.of();
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (JsonProcessingException ex) {
            return Map.of();
        }
    }

    private String stringOrEmpty(Object value) {
        return value == null ? "" : value.toString();
    }

    // --- inner records ---

    record MeasureVersionData(
            UUID measureId,
            UUID measureVersionId,
            String measureName,
            String version,
            String policyRef,
            String cqlText,
            String compileStatus,
            Map<String, Object> spec,
            List<ValueSetRef> valueSets
    ) {}

    record CqlDefine(String name, String snippet) {}

    public record ValueSetRef(String name, String oid, String version) {}

    public record TestFixtureRef(String fixtureName, String expectedOutcome) {}

    public record TraceabilityRow(
            String policyCitation,
            String policyRequirement,
            String specField,
            String specValue,
            String cqlDefine,
            String cqlSnippet,
            List<ValueSetRef> valueSets,
            List<String> requiredDataElements,
            List<TestFixtureRef> testFixtures,
            List<String> runtimeEvidenceKeys
    ) {}

    public record TraceabilityGap(String severity, String message) {}

    public record TraceabilityResponse(
            UUID measureId,
            UUID measureVersionId,
            String measureName,
            String version,
            List<TraceabilityRow> rows,
            List<TraceabilityGap> gaps
    ) {}
}
