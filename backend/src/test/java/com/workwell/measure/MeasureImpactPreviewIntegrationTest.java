package com.workwell.measure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.workwell.AbstractIntegrationTest;
import com.workwell.measure.MeasureImpactPreviewService.ImpactPreviewRequest;
import com.workwell.measure.MeasureImpactPreviewService.ImpactPreviewResponse;
import com.workwell.measure.MeasureImpactPreviewService.ImpactPreviewScope;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.test.web.servlet.result.MockMvcResultMatchers;

@SpringBootTest(properties = {
        "workwell.auth.enabled=true",
        "workwell.auth.jwt-secret=test-secret-for-impact-preview"
})
@AutoConfigureMockMvc
class MeasureImpactPreviewIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MeasureService measureService;

    @Autowired
    private MeasureImpactPreviewService impactPreviewService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MockMvc mockMvc;

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewReturnsOutcomeCounts() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Audiogram not seeded"));

        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), null);

        assertThat(response).isNotNull();
        assertThat(response.measureId()).isEqualTo(audiogram.id());
        assertThat(response.populationEvaluated()).isGreaterThan(0);
        assertThat(response.outcomeCounts()).isNotEmpty();

        // All outcome statuses should be represented
        int total = response.outcomeCounts().values().stream().mapToInt(Integer::intValue).sum();
        assertThat(total).isEqualTo(response.populationEvaluated());
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewDoesNotPersistOutcomes() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        int outcomesBefore = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM outcomes", Integer.class);
        impactPreviewService.preview(audiogram.id(), null);
        int outcomesAfter = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM outcomes", Integer.class);

        assertThat(outcomesAfter).isEqualTo(outcomesBefore);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewDoesNotCreateOrUpdateCases() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        int casesBefore = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM cases", Integer.class);
        impactPreviewService.preview(audiogram.id(), null);
        int casesAfter = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM cases", Integer.class);

        assertThat(casesAfter).isEqualTo(casesBefore);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewDoesNotCreateRuns() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        int runsBefore = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runs", Integer.class);
        impactPreviewService.preview(audiogram.id(), null);
        int runsAfter = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runs", Integer.class);

        assertThat(runsAfter).isEqualTo(runsBefore);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewWritesAuditEvent() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        impactPreviewService.preview(audiogram.id(), null);

        int auditCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE event_type = 'MEASURE_IMPACT_PREVIEWED'",
                Integer.class
        );
        assertThat(auditCount).isGreaterThan(0);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewWithExplicitEvaluationDate() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        ImpactPreviewRequest request = new ImpactPreviewRequest(null, "2026-05-01", null);
        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), request);

        assertThat(response.evaluationDate()).isEqualTo("2026-05-01");
        assertThat(response.populationEvaluated()).isGreaterThan(0);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewReturnsSiteAndRoleBreakdown() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), null);

        assertThat(response.siteBreakdown()).isNotNull();
        assertThat(response.roleBreakdown()).isNotNull();
    }

    // --- scope filtering tests ---

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void siteScopedPreviewReturnsSmallerOrEqualPopulation() {
        var audiogram = findAudiogram();
        ImpactPreviewResponse full = impactPreviewService.preview(audiogram.id(), null);

        if (full.siteBreakdown().isEmpty()) return;
        String targetSite = (String) full.siteBreakdown().get(0).get("site");

        ImpactPreviewRequest request = new ImpactPreviewRequest(null, null,
                new ImpactPreviewScope(targetSite, null));
        ImpactPreviewResponse scoped = impactPreviewService.preview(audiogram.id(), request);

        assertThat(scoped.populationEvaluated()).isLessThanOrEqualTo(full.populationEvaluated());
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void siteScopedPreviewContainsOnlyRequestedSiteInBreakdown() {
        var audiogram = findAudiogram();
        ImpactPreviewResponse full = impactPreviewService.preview(audiogram.id(), null);

        if (full.siteBreakdown().isEmpty()) return;
        String targetSite = (String) full.siteBreakdown().get(0).get("site");

        ImpactPreviewRequest request = new ImpactPreviewRequest(null, null,
                new ImpactPreviewScope(targetSite, null));
        ImpactPreviewResponse scoped = impactPreviewService.preview(audiogram.id(), request);

        assertThat(scoped.siteBreakdown())
                .allMatch(row -> targetSite.equals(row.get("site")));
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void employeeScopedPreviewReturnsAtMostOneSubject() {
        var audiogram = findAudiogram();

        ImpactPreviewRequest request = new ImpactPreviewRequest(null, null,
                new ImpactPreviewScope(null, "emp-001"));
        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), request);

        assertThat(response.populationEvaluated()).isLessThanOrEqualTo(1);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void nonexistentScopeReturnsZeroPopulationWithWarning() {
        var audiogram = findAudiogram();

        ImpactPreviewRequest request = new ImpactPreviewRequest(null, null,
                new ImpactPreviewScope("SITE_DOES_NOT_EXIST_XYZ", null));
        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), request);

        assertThat(response.populationEvaluated()).isEqualTo(0);
        assertThat(response.warnings()).anyMatch(w -> w.contains("No employees matched"));
    }

    // --- evaluation date tests ---

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void invalidEvaluationDateThrowsIllegalArgument() {
        var audiogram = findAudiogram();

        assertThatThrownBy(() -> impactPreviewService.preview(audiogram.id(),
                        new ImpactPreviewRequest(null, "not-a-date", null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("evaluationDate");
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void invalidEvaluationDateReturns400ViaController() throws Exception {
        var audiogram = findAudiogram();

        mockMvc.perform(MockMvcRequestBuilders.post("/api/measures/{id}/impact-preview", audiogram.id())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"evaluationDate\":\"not-a-date\"}"))
                .andExpect(MockMvcResultMatchers.status().isBadRequest());
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void blankEvaluationDateDefaultsToToday() {
        var audiogram = findAudiogram();

        ImpactPreviewRequest request = new ImpactPreviewRequest(null, null, null);
        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), request);

        assertThat(response.evaluationDate()).isEqualTo(java.time.LocalDate.now().toString());
        assertThat(response.populationEvaluated()).isGreaterThan(0);
    }

    // --- case impact evaluation period tests ---

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void caseImpactWithNoExistingCasesAllNonCompliantWouldCreate() {
        // Use a far-future evaluation date: no cases will ever exist for 2099-12-31,
        // so every non-compliant preview outcome maps to "would create", never "would update".
        var audiogram = findAudiogram();

        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(),
                new ImpactPreviewRequest(null, "2099-12-31", null));

        int expectedCreates = response.outcomeCounts().getOrDefault("DUE_SOON", 0)
                + response.outcomeCounts().getOrDefault("OVERDUE", 0)
                + response.outcomeCounts().getOrDefault("MISSING_DATA", 0);

        assertThat(response.caseImpact().wouldCreate()).isEqualTo(expectedCreates);
        assertThat(response.caseImpact().wouldUpdate()).isEqualTo(0);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void caseImpactIgnoresCasesFromDifferentEvaluationPeriod() {
        // Verify Fix 3: inserting an open case for a different evaluation period must not
        // affect the case impact counts for the current preview period.

        var audiogram = findAudiogram();

        // Baseline: no existing cases → record the case impact as-is
        ImpactPreviewResponse baseline = impactPreviewService.preview(audiogram.id(), null);
        int baselineWouldCreate = baseline.caseImpact().wouldCreate();
        int baselineWouldUpdate = baseline.caseImpact().wouldUpdate();

        // Insert a synthetic employee (the CQL evaluator uses in-memory FHIR, not the employees table)
        UUID fakeEmpId = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO employees (id, external_id, name) VALUES (?, ?, ?)",
                fakeEmpId, "test-emp-preview-999", "Preview Test Employee"
        );

        // Insert a minimal run row to satisfy the FK on cases.last_run_id
        UUID fakeRunId = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO runs (id, scope_type, trigger_type, status, triggered_by, started_at, " +
                "total_evaluated, compliant, non_compliant, measurement_period_start, measurement_period_end, requested_scope_json) " +
                "VALUES (?, 'ALL_PROGRAMS', 'MANUAL', 'COMPLETED', 'test@workwell.dev', NOW(), " +
                "0, 0, 0, NOW(), NOW(), '{}')",
                fakeRunId
        );

        UUID mvId = jdbcTemplate.queryForObject(
                "SELECT id FROM measure_versions WHERE measure_id = ? ORDER BY created_at DESC LIMIT 1",
                UUID.class,
                audiogram.id()
        );

        // Insert an open case with evaluation_period unrelated to today
        jdbcTemplate.update(
                "INSERT INTO cases (id, employee_id, measure_version_id, evaluation_period, status, priority, current_outcome_status, last_run_id) " +
                "VALUES (gen_random_uuid(), ?, ?, '2016-01-01', 'OPEN', 'HIGH', 'OVERDUE', ?)",
                fakeEmpId, mvId, fakeRunId
        );

        // Re-run preview for today — the 2016 case must have zero effect on case impact
        ImpactPreviewResponse after = impactPreviewService.preview(audiogram.id(), null);

        assertThat(after.caseImpact().wouldCreate()).isEqualTo(baselineWouldCreate);
        assertThat(after.caseImpact().wouldUpdate()).isEqualTo(baselineWouldUpdate);

        jdbcTemplate.update("DELETE FROM cases WHERE evaluation_period = '2016-01-01'");
        jdbcTemplate.update("DELETE FROM runs WHERE id = ?", fakeRunId);
        jdbcTemplate.update("DELETE FROM employees WHERE id = ?", fakeEmpId);
    }

    // --- helper ---

    private MeasureService.MeasureCatalogItem findAudiogram() {
        return measureService.listMeasures().stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Audiogram not seeded"));
    }
}
