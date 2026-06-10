package com.workwell.engine.model;

import java.util.List;
import java.util.Map;

/**
 * Result of a headless bundle evaluation: the normalized compliance bucket plus the define-level
 * expression results (the evidence core). Produced by
 * {@code CqlEvaluationService.evaluateBundle(...)} for arbitrary FHIR bundles — the
 * "patient + YAML → compliant?" surface (E2 / #88).
 */
public record BundleOutcome(
        String subjectId,
        String outcomeStatus,
        List<Map<String, Object>> expressionResults) {
}
