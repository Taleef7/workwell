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
    void resolveForOutcomePicksTheTemplateMatchingTheOutcomeBucketAndMeasure() {
        // MISSING_DATA → the missing-data template, regardless of measure.
        assertThat(outreachTemplateService.resolveForOutcome(null, "MISSING_DATA", "Audiogram").name())
                .isEqualTo("Missing Data Follow-Up");

        // OVERDUE → the GENERIC reminder for ANY measure — never a measure-specific body (the audiogram
        // overdue template hard-codes audiogram copy and would be wrong for a TB/HAZWOPER case).
        assertThat(outreachTemplateService.resolveForOutcome(null, "OVERDUE", "TB Screening").name())
                .isEqualTo("General Compliance Reminder");
        assertThat(outreachTemplateService.resolveForOutcome(null, "OVERDUE", "Audiogram").name())
                .isEqualTo("General Compliance Reminder");

        // DUE_SOON is measure-aware (the reminder for that measure).
        assertThat(outreachTemplateService.resolveForOutcome(null, "DUE_SOON", "Audiogram").name())
                .isEqualTo("Hearing Conservation Overdue Outreach");
        assertThat(outreachTemplateService.resolveForOutcome(null, "DUE_SOON", "TB Screening").name())
                .isEqualTo("TB Surveillance Follow-Up");
        assertThat(outreachTemplateService.resolveForOutcome(null, "DUE_SOON", "Flu Vaccine").name())
                .isEqualTo("General Compliance Reminder");
    }

    @Test
    void manualAndAutoNotificationSelectionAgree() {
        // The manual preview/send default and the auto-notification path must pick the SAME template.
        for (String outcome : new String[] {"OVERDUE", "DUE_SOON", "MISSING_DATA"}) {
            for (String measure : new String[] {"Audiogram", "TB Screening", "Flu Vaccine"}) {
                assertThat(outreachTemplateService.resolveForOutcome(null, outcome, measure).name())
                        .as("manual default == auto-notification template for %s / %s", outcome, measure)
                        .isEqualTo(outreachTemplateService.templateNameForOutcome(outcome, measure));
            }
        }
    }
}
