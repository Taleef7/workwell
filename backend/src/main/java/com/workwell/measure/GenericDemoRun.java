package com.workwell.measure;

import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.util.List;
import java.util.Map;

public record GenericDemoRun(
        String runId,
        String measureName,
        String measureVersion,
        String evaluationDate,
        RunSummary summary,
        List<GenericOutcome> outcomes
) {
    public static GenericDemoRun fromPayload(DemoRunPayload payload) {
        List<GenericOutcome> outcomes = payload.outcomes().stream()
                .map(outcome -> new GenericOutcome(
                        outcome.subjectId(),
                        outcome.outcome(),
                        outcome.summary(),
                        outcome.evidenceJson()
                ))
                .toList();
        long compliant = outcomes.stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
        long dueSoon = outcomes.stream().filter(o -> "DUE_SOON".equals(o.outcome())).count();
        long overdue = outcomes.stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
        long missingData = outcomes.stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
        long excluded = outcomes.stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();
        return new GenericDemoRun(
                payload.runId(),
                payload.measureName(),
                payload.measureVersion(),
                payload.evaluationDate(),
                new RunSummary(compliant, dueSoon, overdue, missingData, excluded),
                outcomes
        );
    }

    public record RunSummary(
            long compliant,
            long dueSoon,
            long overdue,
            long missingData,
            long excluded
    ) {
    }

    public record GenericOutcome(
            String subjectId,
            String outcome,
            String summary,
            Map<String, Object> evidenceJson
    ) {
    }
}
