package com.workwell.engine.port;

import com.workwell.engine.model.MeasureDefinition;

/**
 * Port: supplies the {@link MeasureDefinition} bindings for a measure by name. The synthetic adapter
 * holds the demo bindings; E2 adds a YAML-backed provider behind this same port.
 */
public interface MeasureDefinitionProvider {

    /**
     * @return the definition for {@code measureName}, or {@code null} if the measure is unsupported.
     */
    MeasureDefinition forMeasure(String measureName);
}
