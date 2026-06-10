package com.workwell.engine.yaml;

import com.workwell.engine.model.MeasureDefinition;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.yaml.snakeyaml.Yaml;

/**
 * Parses + validates one measure YAML document (schema v1, see
 * docs/superpowers/specs/2026-06-10-e2-yaml-measures-design.md). Pure SnakeYAML map-loading — no
 * custom type instantiation, no Spring. Fails fast with the source file + field in the message so a
 * broken measure file breaks loudly at startup rather than silently vanishing from the catalog.
 */
public final class YamlMeasureParser {

    private static final Set<String> TOP_LEVEL_KEYS =
            Set.of("id", "name", "version", "title", "policyRef", "tags", "cql", "bindings");
    private static final Set<String> EVENT_TYPES = Set.of("procedure", "immunization", "observation");

    @SuppressWarnings("unchecked")
    public YamlMeasure parse(String yamlText, String sourceName) {
        Object root = new Yaml().load(yamlText);
        if (!(root instanceof Map)) {
            throw err(sourceName, "document", "expected a YAML mapping at the top level");
        }
        Map<String, Object> doc = (Map<String, Object>) root;
        for (String key : doc.keySet()) {
            if (!TOP_LEVEL_KEYS.contains(key)) {
                throw err(sourceName, key, "unknown top-level key");
            }
        }
        String id = requireString(doc, "id", sourceName);
        String name = requireString(doc, "name", sourceName);
        String version = requireString(doc, "version", sourceName);
        String cqlFile = requireString(doc, "cql", sourceName);
        String title = optionalString(doc, "title");
        String policyRef = optionalString(doc, "policyRef");
        List<String> tags = doc.get("tags") instanceof List<?> rawTags
                ? rawTags.stream().map(String::valueOf).toList()
                : List.of();

        Object bindingsObj = doc.get("bindings");
        if (!(bindingsObj instanceof Map)) {
            throw err(sourceName, "bindings", "required mapping is missing");
        }
        Map<String, Object> bindings = (Map<String, Object>) bindingsObj;
        String rateKey = requireString(bindings, "rateKey", sourceName);
        Map<String, Object> enrollment = requireMap(bindings, "enrollment", sourceName);
        Map<String, Object> waiver = requireMap(bindings, "waiver", sourceName);
        Map<String, Object> event = requireMap(bindings, "event", sourceName);

        String eventType = requireString(event, "type", sourceName);
        if (!EVENT_TYPES.contains(eventType)) {
            throw err(sourceName, "event.type", "must be one of " + EVENT_TYPES + " but was '" + eventType + "'");
        }

        int complianceWindowDays = 365;
        Object windowObj = bindings.get("complianceWindowDays");
        if (windowObj != null) {
            if (!(windowObj instanceof Integer window) || window <= 0) {
                throw err(sourceName, "complianceWindowDays", "must be a positive integer");
            }
            complianceWindowDays = window;
        }

        MeasureDefinition definition = new MeasureDefinition(
                rateKey,
                requireString(enrollment, "code", sourceName),
                requireString(enrollment, "valueSet", sourceName),
                requireString(waiver, "code", sourceName),
                requireString(waiver, "valueSet", sourceName),
                requireString(event, "code", sourceName),
                requireString(event, "valueSet", sourceName),
                "immunization".equals(eventType),
                complianceWindowDays,
                "observation".equals(eventType));
        return new YamlMeasure(id, name, version, title, policyRef, tags, cqlFile, definition);
    }

    private static String requireString(Map<String, Object> map, String field, String sourceName) {
        Object value = map.get(field);
        if (value == null || String.valueOf(value).isBlank()) {
            throw err(sourceName, field, "required field is missing or blank");
        }
        return String.valueOf(value);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> requireMap(Map<String, Object> map, String field, String sourceName) {
        Object value = map.get(field);
        if (!(value instanceof Map)) {
            throw err(sourceName, field, "required mapping is missing");
        }
        return (Map<String, Object>) value;
    }

    private static String optionalString(Map<String, Object> map, String field) {
        Object value = map.get(field);
        return value == null ? null : String.valueOf(value);
    }

    private static IllegalArgumentException err(String sourceName, String field, String message) {
        return new IllegalArgumentException("Invalid measure YAML " + sourceName + ": " + field + " — " + message);
    }
}
