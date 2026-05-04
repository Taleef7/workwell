package com.workwell.run;

import java.util.List;
import java.util.Map;

public final class DemoRunModels {
    private DemoRunModels() {
    }

    public record DemoOutcome(
            String subjectId,
            String subjectName,
            String role,
            String site,
            String outcome,
            String summary,
            Map<String, Object> evidenceJson
    ) {
    }

    public record DemoRunPayload(
            String runId,
            String measureName,
            String measureVersion,
            String evaluationDate,
            List<DemoOutcome> outcomes
    ) {
    }

    public record ActiveMeasureScope(
            java.util.UUID measureId,
            String measureName,
            java.util.UUID measureVersionId,
            String status
    ) {
    }
}
