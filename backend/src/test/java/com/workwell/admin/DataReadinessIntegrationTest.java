package com.workwell.admin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.workwell.AbstractIntegrationTest;
import com.workwell.admin.DataReadinessService.DataElementMapping;
import com.workwell.admin.DataReadinessService.DataReadinessResponse;
import com.workwell.measure.MeasureService;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.test.context.support.WithMockUser;

@SpringBootTest
class DataReadinessIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private DataReadinessService dataReadinessService;

    @Autowired
    private MeasureService measureService;

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void listMappingsReturnsSeededElements() {
        List<DataElementMapping> mappings = dataReadinessService.listMappings();

        assertThat(mappings).isNotEmpty();
        assertThat(mappings).anyMatch(m -> "procedure.audiogram".equals(m.canonicalElement()));
        assertThat(mappings).anyMatch(m -> "employee.role".equals(m.canonicalElement()));
        assertThat(mappings).anyMatch(m -> "procedure.fluVaccine".equals(m.canonicalElement()));
        assertThat(mappings).allMatch(m -> m.mappingStatus() != null && !m.mappingStatus().isBlank());
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void validateMappingsUpdatesLastValidatedAt() {
        List<DataElementMapping> updated = dataReadinessService.validateMappings();

        assertThat(updated).isNotEmpty();
        // After validation, at least some mappings should have lastValidatedAt set
        assertThat(updated).anyMatch(m -> m.lastValidatedAt() != null);
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void computeReadinessForAudiogramReturnsRequiredElements() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Audiogram not seeded"));

        DataReadinessResponse response = dataReadinessService.computeReadiness(audiogram.id());

        assertThat(response).isNotNull();
        assertThat(response.overallStatus()).isIn("READY", "READY_WITH_WARNINGS", "NOT_READY");
        assertThat(response.requiredElements()).isNotEmpty();
        assertThat(response.blockers()).isNotNull();
        assertThat(response.warnings()).isNotNull();
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void computeReadinessElementCountMatchesSpecElements() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        DataReadinessResponse response = dataReadinessService.computeReadiness(audiogram.id());

        // Audiogram spec has 4 required elements: "Last audiogram date", "Role", "Site", "Program enrollment"
        assertThat(response.requiredElements()).hasSize(4);
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void computeReadinessForUnknownMeasureThrows() {
        UUID nonExistent = UUID.fromString("99999999-9999-9999-9999-999999999999");

        assertThatThrownBy(() -> dataReadinessService.computeReadiness(nonExistent))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Measure not found");
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void allSeededMappingsHaveKnownSourceId() {
        List<DataElementMapping> mappings = dataReadinessService.listMappings();

        assertThat(mappings).allMatch(m ->
                "hris".equals(m.sourceId()) || "fhir".equals(m.sourceId())
        );
    }
}
