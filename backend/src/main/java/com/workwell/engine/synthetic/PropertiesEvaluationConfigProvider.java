package com.workwell.engine.synthetic;

import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.engine.port.EvaluationConfigProvider;
import org.springframework.stereotype.Component;

/**
 * Default {@link EvaluationConfigProvider} backed by {@link EvaluationPopulationProperties}
 * ({@code workwell.evaluation.compliance-rates}). Falls back to 0.80 when a measure has no
 * configured rate, preserving the prior behavior.
 */
@Component
public class PropertiesEvaluationConfigProvider implements EvaluationConfigProvider {

    private final EvaluationPopulationProperties properties;

    public PropertiesEvaluationConfigProvider(EvaluationPopulationProperties properties) {
        this.properties = properties;
    }

    @Override
    public double complianceRate(String rateKey) {
        return properties.getComplianceRates().getOrDefault(rateKey, 0.80d);
    }
}
