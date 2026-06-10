package com.workwell.engine.model;

/**
 * Synthetic-evaluation bindings for a measure: the value-set/code bindings, compliance window, and
 * shape flags the engine needs to build a subject's FHIR bundle and classify the outcome.
 *
 * <p>Single source of truth — was the private {@code CqlEvaluationService.MeasureSeedSpec} record.
 * The convenience constructors mirror the original arities 1:1.
 */
public record MeasureDefinition(
        String rateKey,
        String enrollmentCode,
        String enrollmentVs,
        String waiverCode,
        String waiverVs,
        String examCode,
        String examVs,
        boolean useImmunization,
        int complianceWindowDays,
        boolean observationBased) {

    public MeasureDefinition(String rateKey, String enrollmentCode, String enrollmentVs,
                             String waiverCode, String waiverVs, String examCode, String examVs,
                             boolean useImmunization) {
        this(rateKey, enrollmentCode, enrollmentVs, waiverCode, waiverVs,
                examCode, examVs, useImmunization, 365, false);
    }

    public MeasureDefinition(String rateKey, String enrollmentCode, String enrollmentVs,
                             String waiverCode, String waiverVs, String examCode, String examVs,
                             boolean useImmunization, int complianceWindowDays) {
        this(rateKey, enrollmentCode, enrollmentVs, waiverCode, waiverVs,
                examCode, examVs, useImmunization, complianceWindowDays, false);
    }
}
