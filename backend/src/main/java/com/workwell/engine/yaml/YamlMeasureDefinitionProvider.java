package com.workwell.engine.yaml;

import com.workwell.engine.model.MeasureDefinition;
import com.workwell.engine.port.MeasureDefinitionProvider;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;
import org.springframework.util.FileCopyUtils;

/**
 * Default {@link MeasureDefinitionProvider}: loads every classpath measures/*.yaml at construction
 * and indexes by the measure's exact catalog {@code name}. Replaces the former hardcoded switch as
 * the single source of measure bindings (ADR-006). Uses Spring-core's resource resolver as plain
 * library code: no ApplicationContext is required — the no-Spring guard test constructs this with
 * {@code new}.
 */
@Component
public class YamlMeasureDefinitionProvider implements MeasureDefinitionProvider {

    private final Map<String, YamlMeasure> byName = new LinkedHashMap<>();

    public YamlMeasureDefinitionProvider() {
        YamlMeasureParser parser = new YamlMeasureParser();
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver()
                    .getResources("classpath*:measures/*.yaml");
            for (Resource resource : resources) {
                String text = FileCopyUtils.copyToString(
                        new InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8));
                YamlMeasure measure = parser.parse(text, String.valueOf(resource.getFilename()));
                YamlMeasure previous = byName.putIfAbsent(measure.name(), measure);
                if (previous != null) {
                    throw new IllegalStateException("Duplicate measure name '" + measure.name()
                            + "' in " + resource.getFilename());
                }
            }
        } catch (IOException ex) {
            throw new IllegalStateException("Failed to load measure YAML definitions from classpath", ex);
        }
    }

    @Override
    public MeasureDefinition forMeasure(String measureName) {
        YamlMeasure measure = byName.get(measureName);
        return measure == null ? null : measure.definition();
    }

    public int measureCount() {
        return byName.size();
    }
}
