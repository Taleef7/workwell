package com.workwell.engine.yaml;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.workwell.engine.model.MeasureDefinition;
import org.junit.jupiter.api.Test;

class YamlMeasureParserTest {

    private final YamlMeasureParser parser = new YamlMeasureParser();

    private static final String VALID = """
            id: audiogram
            name: Audiogram
            version: 1.0.0
            title: Annual Audiogram Completed
            policyRef: OSHA 29 CFR 1910.95
            tags: [surveillance, hearing, osha]
            cql: audiogram.cql
            bindings:
              rateKey: audiogram
              enrollment: { code: hearing-enrollment, valueSet: "urn:workwell:vs:hearing-enrollment" }
              waiver:     { code: audiogram-waiver,   valueSet: "urn:workwell:vs:audiogram-waiver" }
              event:      { code: audiogram-procedure, valueSet: "urn:workwell:vs:audiogram-procedures", type: procedure }
              complianceWindowDays: 365
            """;

    @Test
    void parsesValidProcedureMeasure() {
        YamlMeasure m = parser.parse(VALID, "audiogram.yaml");
        assertEquals("audiogram", m.id());
        assertEquals("Audiogram", m.name());
        assertEquals("1.0.0", m.version());
        assertEquals("audiogram.cql", m.cqlFile());
        assertEquals("Annual Audiogram Completed", m.title());
        assertEquals("OSHA 29 CFR 1910.95", m.policyRef());
        assertEquals(3, m.tags().size());
        MeasureDefinition d = m.definition();
        assertEquals("audiogram", d.rateKey());
        assertEquals("hearing-enrollment", d.enrollmentCode());
        assertEquals("urn:workwell:vs:hearing-enrollment", d.enrollmentVs());
        assertEquals("audiogram-waiver", d.waiverCode());
        assertEquals("urn:workwell:vs:audiogram-waiver", d.waiverVs());
        assertEquals("audiogram-procedure", d.examCode());
        assertEquals("urn:workwell:vs:audiogram-procedures", d.examVs());
        assertFalse(d.useImmunization());
        assertFalse(d.observationBased());
        assertEquals(365, d.complianceWindowDays());
    }

    @Test
    void immunizationAndObservationTypesMapToFlags() {
        YamlMeasure immz = parser.parse(VALID.replace("type: procedure", "type: immunization"), "x.yaml");
        assertTrue(immz.definition().useImmunization());
        assertFalse(immz.definition().observationBased());

        YamlMeasure obs = parser.parse(VALID.replace("type: procedure", "type: observation"), "x.yaml");
        assertFalse(obs.definition().useImmunization());
        assertTrue(obs.definition().observationBased());
    }

    @Test
    void complianceWindowDefaultsTo365() {
        String noWindow = VALID.replace("  complianceWindowDays: 365\n", "");
        assertEquals(365, parser.parse(noWindow, "x.yaml").definition().complianceWindowDays());
    }

    @Test
    void missingRequiredFieldFailsWithFileAndField() {
        String noName = VALID.replace("name: Audiogram\n", "");
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> parser.parse(noName, "audiogram.yaml"));
        assertTrue(ex.getMessage().contains("audiogram.yaml"), ex.getMessage());
        assertTrue(ex.getMessage().contains("name"), ex.getMessage());
    }

    @Test
    void invalidEventTypeRejected() {
        String bad = VALID.replace("type: procedure", "type: surgery");
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> parser.parse(bad, "x.yaml"));
        assertTrue(ex.getMessage().contains("event.type"), ex.getMessage());
    }

    @Test
    void unknownTopLevelKeyRejected() {
        String extra = VALID + "populations: {}\n";
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> parser.parse(extra, "x.yaml"));
        assertTrue(ex.getMessage().contains("populations"), ex.getMessage());
    }
}
