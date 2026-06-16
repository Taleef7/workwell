package com.workwell.engine.yaml;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.workwell.engine.model.MeasureDefinition;
import org.junit.jupiter.api.Test;

class YamlMeasureDefinitionProviderTest {

    private final YamlMeasureDefinitionProvider provider = new YamlMeasureDefinitionProvider();

    @Test
    void loadsAllTenRunnableMeasuresFromClasspath() {
        assertEquals(10, provider.measureCount());
    }

    @Test
    void looksUpByExactCatalogName() {
        MeasureDefinition audiogram = provider.forMeasure("Audiogram");
        assertNotNull(audiogram);
        assertEquals("audiogram", audiogram.rateKey());
        assertEquals(365, audiogram.complianceWindowDays());

        MeasureDefinition cms122 = provider.forMeasure("Diabetes: Glycemic Status Assessment Greater Than 9%");
        assertNotNull(cms122);
        assertTrue(cms122.observationBased());

        MeasureDefinition diabetes = provider.forMeasure("Diabetes HbA1c Monitoring");
        assertNotNull(diabetes);
        assertEquals(180, diabetes.complianceWindowDays());

        MeasureDefinition cms125 = provider.forMeasure("Breast Cancer Screening");
        assertNotNull(cms125);
        assertEquals(820, cms125.complianceWindowDays());

        MeasureDefinition flu = provider.forMeasure("Flu Vaccine");
        assertNotNull(flu);
        assertTrue(flu.useImmunization());
    }

    @Test
    void unknownMeasureReturnsNull() {
        assertNull(provider.forMeasure("No Such Measure"));
    }
}
