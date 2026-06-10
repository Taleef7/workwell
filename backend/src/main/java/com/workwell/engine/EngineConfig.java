package com.workwell.engine;

import org.springframework.context.annotation.Configuration;

/**
 * Wiring boundary for the measure engine. The {@code com.workwell.engine.synthetic} adapters are the
 * DEFAULT patient/employee data source, and {@code com.workwell.engine.yaml.YamlMeasureDefinitionProvider}
 * supplies measure definitions from declarative measures/*.yaml files (ADR-006). A future real-data
 * adapter (e.g. a FHIR/EHR {@code PatientDataProvider}) is added here as an alternative bean selected
 * by profile/config, while these defaults stay so the live demo is unchanged (ADR-005).
 */
@Configuration
public class EngineConfig {
}
