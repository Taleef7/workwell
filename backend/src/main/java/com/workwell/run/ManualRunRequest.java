package com.workwell.run;

import java.time.LocalDate;
import java.util.UUID;

public record ManualRunRequest(
        RunScopeType scopeType,
        UUID measureId,
        UUID measureVersionId,
        String site,
        String employeeExternalId,
        UUID caseId,
        LocalDate evaluationDate,
        boolean dryRun
) {
}
