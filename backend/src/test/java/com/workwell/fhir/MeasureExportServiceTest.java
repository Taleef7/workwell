package com.workwell.fhir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import ca.uhn.fhir.context.FhirContext;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.util.List;
import java.util.UUID;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.ValueSet;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

class MeasureExportServiceTest {

    @Test
    void omitsValueSetVersionWhenStoredVersionIsBlank() throws Exception {
        JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
        ObjectMapper objectMapper = new ObjectMapper();
        MeasureExportService service = new MeasureExportService(jdbcTemplate, objectMapper);

        UUID measureId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        UUID measureVersionId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        UUID valueSetId = UUID.fromString("33333333-3333-3333-3333-333333333333");

        when(jdbcTemplate.queryForObject(anyString(), any(RowMapper.class), eq(measureId), eq(measureVersionId)))
                .thenAnswer(invocation -> {
                    RowMapper<?> mapper = invocation.getArgument(1);
                    ResultSet rs = mock(ResultSet.class);
                    when(rs.getObject("measure_id")).thenReturn(measureId);
                    when(rs.getString("measure_name")).thenReturn("Audiogram");
                    when(rs.getString("policy_ref")).thenReturn("OSHA 29 CFR 1910.95");
                    when(rs.getObject("measure_version_id")).thenReturn(measureVersionId);
                    when(rs.getString("version")).thenReturn("v1.0");
                    when(rs.getString("status")).thenReturn("DRAFT");
                    when(rs.getString("cql_text")).thenReturn("");
                    when(rs.getString("spec_json_text")).thenReturn("{\"description\":\"Test description\"}");
                    return mapper.mapRow(rs, 0);
                });

        when(jdbcTemplate.query(anyString(), any(RowMapper.class), eq(measureVersionId)))
                .thenAnswer(invocation -> {
                    RowMapper<?> mapper = invocation.getArgument(1);
                    ResultSet rs = mock(ResultSet.class);
                    when(rs.getObject("id")).thenReturn(valueSetId);
                    when(rs.getString("oid")).thenReturn("2.16.840.1.113883.3.1");
                    when(rs.getString("name")).thenReturn("Audiogram Procedures");
                    when(rs.getString("version")).thenReturn("   ");
                    when(rs.getString("canonical_url")).thenReturn("");
                    when(rs.getString("codes_json_text")).thenReturn(
                            "[{\"code\":\"12345-6\",\"display\":\"Baseline audiogram\",\"system\":\"http://loinc.org\"}]"
                    );
                    return List.of(mapper.mapRow(rs, 0));
                });

        String xml = service.exportAsMatBundle(measureId, measureVersionId);

        assertThat(xml).doesNotContain("<version value=\"\"/>");

        Bundle bundle = (Bundle) FhirContext.forR4Cached().newXmlParser().parseResource(xml);
        List<ValueSet> valueSets = bundle.getEntry().stream()
                .map(Bundle.BundleEntryComponent::getResource)
                .filter(ValueSet.class::isInstance)
                .map(ValueSet.class::cast)
                .toList();

        assertThat(valueSets).hasSize(1);
        assertThat(valueSets.get(0).hasVersion()).isFalse();
    }
}
