package com.workwell.engine.yaml;

import com.workwell.engine.model.MeasureDefinition;
import java.util.List;

/** One parsed measure YAML: identity metadata + CQL file reference + engine bindings (schema v1). */
public record YamlMeasure(
        String id,
        String name,
        String version,
        String title,
        String policyRef,
        List<String> tags,
        String cqlFile,
        MeasureDefinition definition) {
}
