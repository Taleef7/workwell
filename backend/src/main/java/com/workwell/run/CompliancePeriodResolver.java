package com.workwell.run;

import com.workwell.engine.model.MeasureDefinition;
import com.workwell.engine.port.MeasureDefinitionProvider;
import java.time.LocalDate;
import org.springframework.stereotype.Component;

/**
 * Resolves the compliance-cycle bucket for a (measure, date) (#150 H1): looks up the measure's
 * compliance window via the measure-definition port, then defers to the pure {@link CompliancePeriod}
 * helper. Shared by every path that must agree on the bucket — run persistence (where outcomes +
 * cases are written) and impact preview (where a candidate run is compared to existing cases) — so
 * they bucket identically. Depends only on the measure-definition port (never mocked), not the CQL
 * eval service, so bucketing survives CQL mocking in tests.
 */
@Component
public class CompliancePeriodResolver {

    private static final String FLU_VACCINE_MEASURE_NAME = "Flu Vaccine";

    private final MeasureDefinitionProvider measureDefinitionProvider;

    public CompliancePeriodResolver(MeasureDefinitionProvider measureDefinitionProvider) {
        this.measureDefinitionProvider = measureDefinitionProvider;
    }

    /** The compliance-cycle anchor period (YYYY-MM-DD) a measure's outcomes + cases bucket into at {@code asOf}. */
    public String bucketPeriod(String measureName, LocalDate asOf) {
        MeasureDefinition spec = measureDefinitionProvider.forMeasure(measureName);
        int window = spec != null ? spec.complianceWindowDays() : 365;
        boolean seasonal = FLU_VACCINE_MEASURE_NAME.equalsIgnoreCase(measureName);
        return CompliancePeriod.cycleKey(window, seasonal, asOf);
    }
}
