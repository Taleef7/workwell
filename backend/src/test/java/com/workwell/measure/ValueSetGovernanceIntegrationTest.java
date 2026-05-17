package com.workwell.measure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.workwell.AbstractIntegrationTest;
import com.workwell.measure.ValueSetGovernanceService.ResolveCheckResult;
import com.workwell.measure.ValueSetGovernanceService.TerminologyMapping;
import com.workwell.measure.ValueSetGovernanceService.ValueSetDiffResponse;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.test.context.support.WithMockUser;

@SpringBootTest
class ValueSetGovernanceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ValueSetGovernanceService valueSetGovernanceService;

    @Autowired
    private MeasureService measureService;

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void listTerminologyMappingsReturnsSeededData() {
        List<TerminologyMapping> mappings = valueSetGovernanceService.listTerminologyMappings();

        assertThat(mappings).hasSizeGreaterThanOrEqualTo(5);
        assertThat(mappings).anyMatch(m -> "LOCAL-AUD-001".equals(m.localCode()) && "APPROVED".equals(m.mappingStatus()));
        assertThat(mappings).anyMatch(m -> "LOCAL-FLU-001".equals(m.localCode()) && "APPROVED".equals(m.mappingStatus()));
        assertThat(mappings).anyMatch(m -> "LOCAL-TB-002".equals(m.localCode()) && "PROPOSED".equals(m.mappingStatus()));
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void createTerminologyMappingPersists() {
        TerminologyMapping created = valueSetGovernanceService.createTerminologyMapping(
                "LOCAL-TEST-001", "Test local code", "urn:workwell:demo",
                "TEST-STD-001", "Test standard code", "urn:workwell:standard",
                "PROPOSED", 0.70, "Integration test mapping"
        );

        assertThat(created.id()).isNotNull();
        assertThat(created.localCode()).isEqualTo("LOCAL-TEST-001");
        assertThat(created.mappingStatus()).isEqualTo("PROPOSED");

        List<TerminologyMapping> all = valueSetGovernanceService.listTerminologyMappings();
        assertThat(all).anyMatch(m -> m.id().equals(created.id()));
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void resolveCheckWithSeededDemoValueSetsLinked() {
        // Trigger measure seeding
        measureService.listMeasures();

        UUID audiogramId = measureService.listMeasures().stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .map(MeasureService.MeasureCatalogItem::id)
                .orElseThrow(() -> new AssertionError("Audiogram measure not seeded"));

        ResolveCheckResult result = valueSetGovernanceService.resolveCheck(audiogramId);

        assertThat(result.measureId()).isEqualTo(audiogramId);
        assertThat(result.valueSets()).isNotEmpty();
        assertThat(result.valueSets()).anyMatch(vs -> "Audiogram Procedure Codes".equals(vs.name()));
        assertThat(result.valueSets()).anyMatch(vs -> vs.codeCount() > 0);
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void resolveCheckUnknownMeasureThrows() {
        UUID unknownId = UUID.fromString("ffffffff-ffff-ffff-ffff-ffffffffffff");
        assertThatThrownBy(() -> valueSetGovernanceService.resolveCheck(unknownId))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Measure not found");
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void diffReturnsDifferenceForTwoValueSets() {
        UUID fromId = UUID.fromString("a0000001-0000-0000-0000-000000000001"); // Audiogram
        UUID toId   = UUID.fromString("a0000001-0000-0000-0000-000000000002"); // TB

        ValueSetDiffResponse diff = valueSetGovernanceService.diff(fromId, toId);

        assertThat(diff.fromId()).isEqualTo(fromId.toString());
        assertThat(diff.toId()).isEqualTo(toId.toString());
        // Audiogram and TB have different codes, so diffs should be non-empty
        assertThat(diff.addedCodes().size() + diff.removedCodes().size()).isGreaterThan(0);
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void allSeededValueSetsHaveNonEmptyCodes() {
        UUID[] seededIds = {
            UUID.fromString("a0000001-0000-0000-0000-000000000001"),
            UUID.fromString("a0000001-0000-0000-0000-000000000002"),
            UUID.fromString("a0000001-0000-0000-0000-000000000003"),
            UUID.fromString("a0000001-0000-0000-0000-000000000004")
        };
        for (UUID id : seededIds) {
            var detail = valueSetGovernanceService.getValueSetDetail(id);
            assertThat(detail.codeCount()).isGreaterThan(0)
                    .as("Seeded value set %s should have codes", id);
            assertThat(detail.resolutionStatus()).isEqualTo("RESOLVED");
        }
    }
}
