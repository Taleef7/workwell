package com.workwell.web.dto;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

public record EmployeeProfileResponse(
    UUID id,
    String externalId,
    String name,
    String role,
    String site,
    String supervisorName,
    LocalDate startDate,
    String fhirPatientId,
    boolean active,
    List<MeasureOutcomeSummary> measureOutcomes,
    List<OpenCaseSummary> openCases,
    List<AuditEventSummary> recentAuditEvents
) {
    public record MeasureOutcomeSummary(
        UUID measureVersionId,
        String measureName,
        String measureVersion,
        String outcomeStatus,
        String lastRunDate,
        Integer daysSinceLastExam,
        Integer daysUntilDue,
        UUID openCaseId
    ) {}

    public record OpenCaseSummary(
        UUID caseId,
        String measureName,
        String outcomeStatus,
        String priority,
        String assignee,
        String slaDueDate,
        Integer slaRemainingDays
    ) {}

    public record AuditEventSummary(
        String eventType,
        String occurredAt,
        String actor,
        String measureName,
        String summary
    ) {}
}
