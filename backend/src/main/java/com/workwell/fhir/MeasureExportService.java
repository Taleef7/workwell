package com.workwell.fhir;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.parser.IParser;
import ca.uhn.fhir.validation.FhirValidator;
import ca.uhn.fhir.validation.ValidationResult;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.hl7.fhir.r4.model.Attachment;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.CodeableConcept;
import org.hl7.fhir.r4.model.Coding;
import org.hl7.fhir.r4.model.Enumerations;
import org.hl7.fhir.r4.model.Library;
import org.hl7.fhir.r4.model.Measure;
import org.hl7.fhir.r4.model.ValueSet;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class MeasureExportService {
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};
    private static final TypeReference<List<Map<String, Object>>> LIST_MAP_TYPE = new TypeReference<>() {};

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final FhirContext fhirContext;

    public MeasureExportService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        this.fhirContext = FhirContext.forR4Cached();
    }

    public String exportAsMatBundle(UUID measureId, UUID measureVersionId) {
        MeasureVersionRow measureVersion = loadMeasureVersion(measureId, measureVersionId);
        List<ValueSetRow> valueSets = loadValueSets(measureVersionId);

        Bundle bundle = new Bundle();
        bundle.setId(UUID.randomUUID().toString());
        bundle.setType(Bundle.BundleType.COLLECTION);

        Library library = buildLibrary(measureVersion);
        Measure measure = buildMeasure(measureVersion, library);

        addEntry(bundle, library);
        addEntry(bundle, measure);
        for (ValueSetRow valueSetRow : valueSets) {
            addEntry(bundle, buildValueSet(valueSetRow));
        }

        validateBundle(bundle);
        IParser parser = fhirContext.newXmlParser().setPrettyPrint(true);
        return parser.encodeResourceToString(bundle);
    }

    private MeasureVersionRow loadMeasureVersion(UUID measureId, UUID measureVersionId) {
        try {
            return jdbcTemplate.queryForObject(
                    """
                    SELECT
                        m.id AS measure_id,
                        m.name AS measure_name,
                        m.policy_ref,
                        mv.id AS measure_version_id,
                        mv.version,
                        mv.status,
                        COALESCE(mv.cql_text, '') AS cql_text,
                        mv.spec_json::text AS spec_json_text
                    FROM measures m
                    JOIN measure_versions mv ON mv.measure_id = m.id
                    WHERE m.id = ? AND mv.id = ?
                    """,
                    (rs, rowNum) -> new MeasureVersionRow(
                            (UUID) rs.getObject("measure_id"),
                            rs.getString("measure_name"),
                            rs.getString("policy_ref"),
                            (UUID) rs.getObject("measure_version_id"),
                            rs.getString("version"),
                            rs.getString("status"),
                            rs.getString("cql_text"),
                            rs.getString("spec_json_text")
                    ),
                    measureId,
                    measureVersionId
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure version not found for the provided measure/version ids.");
        }
    }

    private List<ValueSetRow> loadValueSets(UUID measureVersionId) {
        return jdbcTemplate.query(
                """
                SELECT
                    vs.id,
                    vs.oid,
                    vs.name,
                    vs.version,
                    COALESCE(vs.canonical_url, '') AS canonical_url,
                    vs.codes_json::text AS codes_json_text
                FROM measure_value_set_links mvsl
                JOIN value_sets vs ON vs.id = mvsl.value_set_id
                WHERE mvsl.measure_version_id = ?
                ORDER BY vs.name ASC
                """,
                (rs, rowNum) -> new ValueSetRow(
                        (UUID) rs.getObject("id"),
                        rs.getString("oid"),
                        rs.getString("name"),
                        rs.getString("version"),
                        rs.getString("canonical_url"),
                        rs.getString("codes_json_text")
                ),
                measureVersionId
        );
    }

    private Library buildLibrary(MeasureVersionRow row) {
        Library library = new Library();
        library.setId(UUID.randomUUID().toString());
        library.setName(safeIdentifier(row.measureName()) + "CQL");
        library.setTitle(row.measureName() + " CQL Library");
        library.setVersion(row.version());
        library.setStatus(resolvePublicationStatus(row.status()));
        library.setType(new CodeableConcept().addCoding(
                new Coding()
                        .setSystem("http://terminology.hl7.org/CodeSystem/library-type")
                        .setCode("logic-library")
                        .setDisplay("Logic Library")
        ));

        if (row.cqlText() != null && !row.cqlText().isBlank()) {
            Attachment attachment = new Attachment();
            attachment.setContentType("text/cql");
            // Provide raw UTF-8 bytes; HAPI serializes to base64 in XML.
            attachment.setData(row.cqlText().getBytes(StandardCharsets.UTF_8));
            library.addContent(attachment);
        }
        return library;
    }

    private Measure buildMeasure(MeasureVersionRow row, Library library) {
        Measure measure = new Measure();
        measure.setId(UUID.randomUUID().toString());
        measure.setName(safeIdentifier(row.measureName()));
        measure.setTitle(row.measureName());
        measure.setVersion(row.version());
        measure.setStatus(resolvePublicationStatus(row.status()));
        measure.setPublisher("WorkWell Measure Studio");
        measure.setDescription(resolveMeasureDescription(row.specJsonText(), row.policyRef()));
        measure.addLibrary("urn:uuid:" + library.getIdElement().getIdPart());
        return measure;
    }

    private ValueSet buildValueSet(ValueSetRow row) {
        ValueSet valueSet = new ValueSet();
        valueSet.setId(UUID.randomUUID().toString());
        valueSet.setName(safeIdentifier(row.name()));
        valueSet.setTitle(row.name());
        String valueSetVersion = row.version() == null ? "" : row.version().trim();
        if (!valueSetVersion.isEmpty()) {
            valueSet.setVersion(valueSetVersion);
        }
        valueSet.setStatus(Enumerations.PublicationStatus.ACTIVE);
        valueSet.setUrl(resolveValueSetUrl(row));

        Map<String, List<Map<String, Object>>> codesBySystem = groupCodesBySystem(row.codesJsonText());
        if (!codesBySystem.isEmpty()) {
            ValueSet.ValueSetComposeComponent compose = new ValueSet.ValueSetComposeComponent();
            for (Map.Entry<String, List<Map<String, Object>>> entry : codesBySystem.entrySet()) {
                ValueSet.ConceptSetComponent include = new ValueSet.ConceptSetComponent();
                include.setSystem(entry.getKey());
                for (Map<String, Object> codeRow : entry.getValue()) {
                    String code = valueAsString(codeRow.get("code"));
                    if (code.isBlank()) {
                        continue;
                    }
                    ValueSet.ConceptReferenceComponent concept = new ValueSet.ConceptReferenceComponent();
                    concept.setCode(code);
                    String display = valueAsString(codeRow.get("display"));
                    if (!display.isBlank()) {
                        concept.setDisplay(display);
                    }
                    include.addConcept(concept);
                }
                if (!include.getConcept().isEmpty()) {
                    compose.addInclude(include);
                }
            }
            if (!compose.getInclude().isEmpty()) {
                valueSet.setCompose(compose);
            }
        }
        return valueSet;
    }

    private void addEntry(Bundle bundle, org.hl7.fhir.r4.model.Resource resource) {
        bundle.addEntry()
                .setFullUrl("urn:uuid:" + resource.getIdElement().getIdPart())
                .setResource(resource);
    }

    private void validateBundle(Bundle bundle) {
        FhirValidator validator = fhirContext.newValidator();
        ValidationResult result = validator.validateWithResult(bundle);
        if (result.isSuccessful()) {
            return;
        }
        String firstMessage = result.getMessages().isEmpty()
                ? "Unknown FHIR validation failure."
                : result.getMessages().get(0).getMessage();
        throw new IllegalStateException("FHIR validation failed for MAT export: " + firstMessage);
    }

    private String resolveValueSetUrl(ValueSetRow row) {
        if (row.canonicalUrl() != null && !row.canonicalUrl().isBlank()) {
            return row.canonicalUrl();
        }
        if (row.oid() != null && !row.oid().isBlank()) {
            return "urn:oid:" + row.oid();
        }
        return "urn:uuid:" + row.id();
    }

    private String resolveMeasureDescription(String specJsonText, String policyRef) {
        if (specJsonText != null && !specJsonText.isBlank()) {
            try {
                Map<String, Object> spec = objectMapper.readValue(specJsonText, MAP_TYPE);
                String description = valueAsString(spec.get("description"));
                if (!description.isBlank()) {
                    return description;
                }
            } catch (Exception ignored) {
                // Fall back to policy reference when spec parsing fails.
            }
        }
        if (policyRef != null && !policyRef.isBlank()) {
            return "Policy reference: " + policyRef;
        }
        return "Exported from WorkWell Measure Studio";
    }

    private Map<String, List<Map<String, Object>>> groupCodesBySystem(String codesJsonText) {
        Map<String, List<Map<String, Object>>> grouped = new LinkedHashMap<>();
        if (codesJsonText == null || codesJsonText.isBlank()) {
            return grouped;
        }
        try {
            List<Map<String, Object>> rows = objectMapper.readValue(codesJsonText, LIST_MAP_TYPE);
            for (Map<String, Object> row : rows) {
                String system = valueAsString(row.get("system"));
                if (system.isBlank()) {
                    system = "urn:workwell:local";
                }
                grouped.computeIfAbsent(system, key -> new ArrayList<>()).add(row);
            }
        } catch (Exception ignored) {
            return Map.of();
        }
        return grouped;
    }

    private String safeIdentifier(String value) {
        if (value == null || value.isBlank()) {
            return "WorkWellMeasure";
        }
        String normalized = value.replaceAll("[^A-Za-z0-9]+", "");
        return normalized.isBlank() ? "WorkWellMeasure" : normalized;
    }

    private String valueAsString(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private Enumerations.PublicationStatus resolvePublicationStatus(String status) {
        String normalized = status == null ? "" : status.trim().toUpperCase();
        return switch (normalized) {
            case "ACTIVE" -> Enumerations.PublicationStatus.ACTIVE;
            case "APPROVED" -> Enumerations.PublicationStatus.ACTIVE;
            case "DEPRECATED" -> Enumerations.PublicationStatus.RETIRED;
            case "DRAFT" -> Enumerations.PublicationStatus.DRAFT;
            default -> Enumerations.PublicationStatus.DRAFT;
        };
    }

    private record MeasureVersionRow(
            UUID measureId,
            String measureName,
            String policyRef,
            UUID measureVersionId,
            String version,
            String status,
            String cqlText,
            String specJsonText
    ) {}

    private record ValueSetRow(
            UUID id,
            String oid,
            String name,
            String version,
            String canonicalUrl,
            String codesJsonText
    ) {}
}
