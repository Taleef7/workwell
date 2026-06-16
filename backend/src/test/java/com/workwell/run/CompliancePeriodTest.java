package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.run.CompliancePeriod.Cadence;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

class CompliancePeriodTest {

    @Test
    void annualBucketsToCalendarYearStart() {
        assertThat(CompliancePeriod.cycleAnchor(Cadence.ANNUAL, LocalDate.of(2026, 6, 13)))
                .isEqualTo(LocalDate.of(2026, 1, 1));
        assertThat(CompliancePeriod.cycleAnchor(Cadence.ANNUAL, LocalDate.of(2026, 12, 31)))
                .isEqualTo(LocalDate.of(2026, 1, 1));
    }

    @Test
    void biannualBucketsToCurrentHalf() {
        assertThat(CompliancePeriod.cycleAnchor(Cadence.BIANNUAL, LocalDate.of(2026, 3, 1)))
                .isEqualTo(LocalDate.of(2026, 1, 1));
        assertThat(CompliancePeriod.cycleAnchor(Cadence.BIANNUAL, LocalDate.of(2026, 9, 1)))
                .isEqualTo(LocalDate.of(2026, 7, 1));
    }

    @Test
    void seasonalBucketsToFluSeasonStart() {
        // Jul–Dec → this year's Jul 1
        assertThat(CompliancePeriod.cycleAnchor(Cadence.SEASONAL, LocalDate.of(2026, 10, 1)))
                .isEqualTo(LocalDate.of(2026, 7, 1));
        // Jan–Jun → previous year's Jul 1 (same season)
        assertThat(CompliancePeriod.cycleAnchor(Cadence.SEASONAL, LocalDate.of(2026, 2, 1)))
                .isEqualTo(LocalDate.of(2025, 7, 1));
    }

    @Test
    void cadenceClassification() {
        assertThat(CompliancePeriod.cadenceFor(365, false)).isEqualTo(Cadence.ANNUAL);
        assertThat(CompliancePeriod.cadenceFor(820, false)).isEqualTo(Cadence.ANNUAL);
        assertThat(CompliancePeriod.cadenceFor(180, false)).isEqualTo(Cadence.BIANNUAL);
        assertThat(CompliancePeriod.cadenceFor(365, true)).isEqualTo(Cadence.SEASONAL);
    }

    @Test
    void idempotentWithinACycle() {
        // Two different run dates in the same annual cycle → identical bucket (no new cohort).
        String a = CompliancePeriod.cycleKey(365, false, LocalDate.of(2026, 1, 5));
        String b = CompliancePeriod.cycleKey(365, false, LocalDate.of(2026, 11, 20));
        assertThat(a).isEqualTo(b).isEqualTo("2026-01-01");
    }
}
