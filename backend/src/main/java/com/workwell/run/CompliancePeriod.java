package com.workwell.run;

import java.time.LocalDate;

/**
 * Compliance-cycle bucketing for recurring evaluations (#150 H1).
 *
 * <p>A nightly monitoring run must keep a bounded, current set of cases — one per
 * (employee &times; measure) per compliance cycle, updated idempotently — instead of minting a new
 * {@code evaluation_period} cohort every run (which produced 4,703 perpetually-open cases).
 *
 * <p>Compliance is still computed <em>as of the run date</em>, so the CQL/outcome numbers are
 * unchanged; only the {@code evaluation_period} that keys outcomes + cases is anchored to the
 * measure's current cycle. The anchor is a {@link LocalDate} so the stored {@code evaluation_period}
 * string stays date-shaped and existing parsers keep working.
 */
public final class CompliancePeriod {

    private CompliancePeriod() {
    }

    /** How often a measure's compliance is re-snapshotted into a fresh case cohort. */
    public enum Cadence {
        ANNUAL,
        BIANNUAL,
        SEASONAL
    }

    /**
     * Classify a measure's cadence from its compliance window + seasonal flag. Seasonal (e.g. flu)
     * → season cycle; short windows (&le; 200 days, e.g. the 180-day HbA1c measure) → half-year;
     * everything else (365, the 820-day CMS125, value-based CMS122) → calendar year.
     */
    public static Cadence cadenceFor(int complianceWindowDays, boolean seasonal) {
        if (seasonal) {
            return Cadence.SEASONAL;
        }
        if (complianceWindowDays > 0 && complianceWindowDays <= 200) {
            return Cadence.BIANNUAL;
        }
        return Cadence.ANNUAL;
    }

    /**
     * The stable cycle-anchor date that every run within the same cycle shares, so re-evaluations
     * collapse onto one case per (employee &times; measure &times; cycle).
     */
    public static LocalDate cycleAnchor(Cadence cadence, LocalDate asOf) {
        return switch (cadence) {
            case ANNUAL -> LocalDate.of(asOf.getYear(), 1, 1);
            case BIANNUAL -> asOf.getMonthValue() <= 6
                    ? LocalDate.of(asOf.getYear(), 1, 1)
                    : LocalDate.of(asOf.getYear(), 7, 1);
            // Flu-style season runs Jul–Jun; anchor at Jul 1 of the season's start year.
            case SEASONAL -> asOf.getMonthValue() >= 7
                    ? LocalDate.of(asOf.getYear(), 7, 1)
                    : LocalDate.of(asOf.getYear() - 1, 7, 1);
        };
    }

    /** The cycle-anchor {@code evaluation_period} (date string) for a measure as of a run date. */
    public static String cycleKey(int complianceWindowDays, boolean seasonal, LocalDate asOf) {
        return cycleAnchor(cadenceFor(complianceWindowDays, seasonal), asOf).toString();
    }
}
