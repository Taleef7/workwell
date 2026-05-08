package com.workwell.compile;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "workwell.evaluation")
public class EvaluationPopulationProperties {
    private Map<String, Double> complianceRates = new LinkedHashMap<>(Map.of(
            "audiogram", 0.78d,
            "tb_surveillance", 0.91d,
            "hazwoper", 0.65d,
            "flu_vaccine", 0.84d
    ));

    public Map<String, Double> getComplianceRates() {
        return complianceRates;
    }

    public void setComplianceRates(Map<String, Double> complianceRates) {
        if (complianceRates == null || complianceRates.isEmpty()) {
            return;
        }
        this.complianceRates = new LinkedHashMap<>(complianceRates);
    }
}
