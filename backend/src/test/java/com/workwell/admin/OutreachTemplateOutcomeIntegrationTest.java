package com.workwell.admin;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * #150 M1: when no templateId is chosen, the auto-selected outreach template matches the case's
 * OUTCOME bucket (OVERDUE/MISSING_DATA/DUE_SOON) instead of always returning the first/newest
 * template. Templates are the V007/V008 seeds (Flyway).
 */
@SpringBootTest
class OutreachTemplateOutcomeIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private OutreachTemplateService outreachTemplateService;

    @Test
    void resolveForOutcomePicksTheTemplateMatchingTheOutcomeBucket() {
        assertThat(outreachTemplateService.resolveForOutcome(null, "MISSING_DATA").name())
                .as("MISSING_DATA → the missing-data template")
                .containsIgnoringCase("missing");
        assertThat(outreachTemplateService.resolveForOutcome(null, "OVERDUE").name())
                .as("OVERDUE → an overdue template")
                .containsIgnoringCase("overdue");
        assertThat(outreachTemplateService.resolveForOutcome(null, "DUE_SOON").name())
                .as("DUE_SOON → a reminder template")
                .containsIgnoringCase("reminder");
        // An OUTREACH default is chosen for an unknown/other status (never an appointment/escalation type).
        assertThat(outreachTemplateService.resolveForOutcome(null, "EXCLUDED").type())
                .isEqualToIgnoringCase("OUTREACH");
    }
}
