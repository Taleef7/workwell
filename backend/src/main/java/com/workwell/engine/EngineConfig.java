package com.workwell.engine;

import org.springframework.context.annotation.Configuration;

/**
 * Wiring boundary for the measure engine. The {@code com.workwell.engine.synthetic} adapters are
 * {@code @Component} beans and are the DEFAULT data source, so the live demo is unchanged. A future
 * real-data adapter (e.g. a FHIR/EHR {@code PatientDataProvider}) is added here as an alternative
 * bean selected by profile/config, while the synthetic beans stay the default
 * (see docs/PLAN.md principle 5 and ADR-005).
 */
@Configuration
public class EngineConfig {
}
