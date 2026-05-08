package com.workwell.caseflow;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.admin.OutreachTemplateService;
import com.workwell.admin.WaiverService;
import com.workwell.security.SecurityActor;
import com.workwell.run.DemoRunModels.DemoOutcome;
import java.io.IOException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.Locale;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class CaseFlowService {
    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final OutreachTemplateService outreachTemplateService;
    private final WaiverService waiverService;

    public CaseFlowService(
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper,
            OutreachTemplateService outreachTemplateService,
            WaiverService waiverService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        this.outreachTemplateService = outreachTemplateService;
        this.waiverService = waiverService;
    }

    public void upsertCases(
            UUID runId,
            UUID measureVersionId,
            String evaluationPeriod,
            List<UUID> employeeIds,
            List<DemoOutcome> outcomes
    ) {
        for (int i = 0; i < outcomes.size(); i++) {
            UUID employeeId = employeeIds.get(i);
            DemoOutcome outcome = outcomes.get(i);
            if ("EXCLUDED".equals(outcome.outcome())) {
                upsertExcludedCase(runId, measureVersionId, evaluationPeriod, employeeId, outcome);
            } else if (requiresOpenCase(outcome.outcome())) {
                upsertOpenCase(runId, measureVersionId, evaluationPeriod, employeeId, outcome);
            } else {
                closeExistingCaseIfNeeded(runId, measureVersionId, evaluationPeriod, employeeId, outcome);
            }
        }
    }

    public List<CaseSummary> listCases(
            String statusFilter,
            UUID measureId,
            String priority,
            String assignee,
            String site,
            Instant from,
            Instant to
    ) {
        String normalizedStatusFilter = normalizeStatusFilter(statusFilter);
        StringBuilder sql = new StringBuilder("""
                SELECT c.id AS case_id,
                       e.external_id AS employee_id,
                       e.name AS employee_name,
                       e.site AS employee_site,
                       c.measure_version_id,
                       m.name AS measure_name,
                       mv.version AS measure_version,
                       c.evaluation_period,
                       c.status,
                       c.priority,
                       c.assignee,
                       c.current_outcome_status,
                       c.last_run_id,
                       w.exclusion_reason AS exclusion_reason,
                       w.expires_at AS waiver_expires_at,
                       CASE
                           WHEN w.active AND w.expires_at IS NOT NULL AND w.expires_at < NOW() THEN TRUE
                           ELSE FALSE
                       END AS waiver_expired,
                       COALESCE((SELECT COUNT(*) FROM outreach_records orw WHERE orw.case_id = c.id), 0) AS outreach_record_count,
                       c.updated_at
                FROM cases c
                JOIN employees e ON c.employee_id = e.id
                JOIN measure_versions mv ON c.measure_version_id = mv.id
                JOIN measures m ON mv.measure_id = m.id
                LEFT JOIN LATERAL (
                    SELECT w.exclusion_reason, w.expires_at, w.active
                    FROM waivers w
                    WHERE w.employee_id = c.employee_id
                      AND w.measure_version_id = c.measure_version_id
                    ORDER BY w.active DESC, w.granted_at DESC, w.id DESC
                    LIMIT 1
                ) w ON TRUE
                WHERE 1=1
                """);

        List<Object> params = new ArrayList<>();
        switch (normalizedStatusFilter) {
            case "all" -> {
            }
            case "closed" -> sql.append(" AND c.status IN ('CLOSED', 'RESOLVED')");
            case "excluded" -> sql.append(" AND c.status = 'EXCLUDED'");
            case "open" -> sql.append(" AND c.status = 'OPEN'");
            default -> throw new IllegalStateException("Unexpected status filter: " + normalizedStatusFilter);
        }
        if (measureId != null) {
            sql.append(" AND m.id = ?");
            params.add(measureId);
        }
        if (priority != null && !priority.isBlank()) {
            sql.append(" AND LOWER(c.priority) = LOWER(?)");
            params.add(priority);
        }
        if (assignee != null && !assignee.isBlank()) {
            sql.append(" AND LOWER(COALESCE(c.assignee, 'unassigned')) = LOWER(?)");
            params.add(assignee);
        }
        if (site != null && !site.isBlank()) {
            sql.append(" AND LOWER(COALESCE(e.site, '')) = LOWER(?)");
            params.add(site);
        }
        if (from != null) {
            sql.append(" AND c.created_at >= ?");
            params.add(Timestamp.from(from));
        }
        if (to != null) {
            sql.append(" AND c.created_at <= ?");
            params.add(Timestamp.from(to));
        }
        sql.append(" AND mv.status = 'Active'");
        sql.append(" ORDER BY c.updated_at DESC");

        return jdbcTemplate.query(sql.toString(), (rs, rowNum) -> new CaseSummary(
                (UUID) rs.getObject("case_id"),
                rs.getString("employee_id"),
                rs.getString("employee_name"),
                rs.getString("employee_site"),
                (UUID) rs.getObject("measure_version_id"),
                rs.getString("measure_name"),
                rs.getString("measure_version"),
                rs.getString("evaluation_period"),
                rs.getString("status"),
                rs.getString("priority"),
                rs.getString("assignee"),
                rs.getString("current_outcome_status"),
                (UUID) rs.getObject("last_run_id"),
                rs.getString("exclusion_reason"),
                toInstant(rs.getObject("waiver_expires_at")),
                rs.getBoolean("waiver_expired"),
                rs.getInt("outreach_record_count"),
                rs.getTimestamp("updated_at").toInstant()
        ), params.toArray());
    }

    private String normalizeStatusFilter(String statusFilter) {
        if (statusFilter == null || statusFilter.isBlank()) {
            return "open";
        }
        return switch (statusFilter.trim().toLowerCase(Locale.ROOT)) {
            case "all", "closed", "excluded", "open" -> statusFilter.trim().toLowerCase(Locale.ROOT);
            default -> throw new IllegalArgumentException("status must be one of open, closed, excluded, all");
        };
    }

    public Optional<CaseDetail> loadCase(UUID caseId) {
        String sql = """
                SELECT c.id AS case_id,
                       e.external_id AS employee_id,
                       e.name AS employee_name,
                       m.name AS measure_name,
                       mv.version AS measure_version,
                       c.evaluation_period,
                       c.status,
                       c.priority,
                       c.assignee,
                       c.next_action,
                       c.current_outcome_status,
                       c.last_run_id,
                       c.measure_version_id,
                       c.created_at,
                       c.updated_at,
                       c.closed_at,
                       c.closed_reason,
                       c.closed_by,
                       w.exclusion_reason AS exclusion_reason,
                       w.expires_at AS waiver_expires_at,
                       CASE
                           WHEN w.active AND w.expires_at IS NOT NULL AND w.expires_at < NOW() THEN TRUE
                           ELSE FALSE
                       END AS waiver_expired,
                       o.evidence_json,
                       o.status AS outcome_status,
                       o.evaluated_at AS outcome_evaluated_at
                FROM cases c
                JOIN employees e ON c.employee_id = e.id
                JOIN measure_versions mv ON c.measure_version_id = mv.id
                JOIN measures m ON mv.measure_id = m.id
                LEFT JOIN LATERAL (
                    SELECT w.exclusion_reason, w.expires_at, w.active
                    FROM waivers w
                    WHERE w.employee_id = c.employee_id
                      AND w.measure_version_id = c.measure_version_id
                    ORDER BY w.active DESC, w.granted_at DESC, w.id DESC
                    LIMIT 1
                ) w ON TRUE
                LEFT JOIN outcomes o ON o.run_id = c.last_run_id
                    AND o.employee_id = c.employee_id
                    AND o.measure_version_id = c.measure_version_id
                    AND o.evaluation_period = c.evaluation_period
                WHERE c.id = ?
                """;

        try {
            return jdbcTemplate.query(sql, rs -> {
                if (!rs.next()) {
                    return Optional.<CaseDetail>empty();
                }

                UUID resolvedCaseId = (UUID) rs.getObject("case_id");
                List<AuditEvent> timeline = loadCaseTimeline(resolvedCaseId);
                String evidenceJson = rs.getString("evidence_json");

                return Optional.of(new CaseDetail(
                        resolvedCaseId,
                        rs.getString("employee_id"),
                        rs.getString("employee_name"),
                        rs.getString("measure_name"),
                        (UUID) rs.getObject("measure_version_id"),
                        rs.getString("measure_version"),
                        rs.getString("evaluation_period"),
                        rs.getString("status"),
                        rs.getString("priority"),
                        rs.getString("assignee"),
                        rs.getString("next_action"),
                        rs.getString("current_outcome_status"),
                        (UUID) rs.getObject("last_run_id"),
                        toInstant(rs.getObject("created_at")),
                        toInstant(rs.getObject("updated_at")),
                        toInstant(rs.getObject("closed_at")),
                        rs.getString("closed_reason"),
                        rs.getString("closed_by"),
                        rs.getString("exclusion_reason"),
                        toInstant(rs.getObject("waiver_expires_at")),
                        rs.getBoolean("waiver_expired"),
                        evidenceJson == null ? Map.of() : readJson(evidenceJson),
                        rs.getString("outcome_status"),
                        outcomeSummaryFor(rs.getString("outcome_status")),
                        toInstant(rs.getObject("outcome_evaluated_at")),
                        findLatestOutreachDeliveryStatus(resolvedCaseId),
                        timeline
                ));
            }, caseId);
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    public Optional<CaseDetail> sendOutreach(UUID caseId, String actor) {
        return sendOutreach(caseId, actor, null);
    }

    public Optional<OutreachPreview> previewOutreach(UUID caseId, UUID templateId) {
        Optional<CaseDetail> detail = loadCase(caseId);
        if (detail.isEmpty()) {
            return Optional.empty();
        }
        CaseDetail c = detail.get();
        OutreachTemplateService.OutreachTemplate template = outreachTemplateService.resolveByIdOrDefault(templateId);
        String subjectTemplate = template == null ? "Outreach Reminder for {{measureName}}" : template.subject();
        String bodyTemplate = template == null
                ? "Hello {{employeeName}}, please complete required follow-up for {{measureName}}."
                : template.bodyText();

        String dueDate = computeDueDate(c);
        String renderedSubject = renderTemplate(subjectTemplate, c.employeeName(), c.measureName(), dueDate, c.currentOutcomeStatus());
        String renderedBody = renderTemplate(bodyTemplate, c.employeeName(), c.measureName(), dueDate, c.currentOutcomeStatus());
        return Optional.of(new OutreachPreview(
                template == null ? null : template.id(),
                template == null ? "Default Template" : template.name(),
                renderedSubject,
                renderedBody,
                c.employeeName(),
                c.measureName(),
                dueDate
        ));
    }

    public Optional<CaseDetail> sendOutreach(UUID caseId, String actor, UUID templateId) {
        Optional<CaseContext> context = loadCaseContext(caseId);
        if (context.isEmpty()) {
            return Optional.empty();
        }

        CaseContext existing = context.get();
        OutreachTemplateService.OutreachTemplate template = outreachTemplateService.resolveByIdOrDefault(templateId);
        String nextAction = "Wait for employee follow-up, then rerun to verify closure.";
        jdbcTemplate.update(
                "UPDATE cases SET status = ?, next_action = ?, updated_at = NOW() WHERE id = ?",
                "OPEN",
                nextAction,
                caseId
        );

        Map<String, Object> actionPayload = new LinkedHashMap<>();
        actionPayload.put("autoTriggered", false);
        actionPayload.put("channel", "SIMULATED_EMAIL");
        actionPayload.put("template", template == null ? "default-template" : template.name());
        actionPayload.put("templateName", template == null ? "Default Template" : template.name());
        actionPayload.put("templateId", template == null ? null : template.id());
        actionPayload.put("subject", template == null ? "Outreach Reminder" : template.subject());
        actionPayload.put("deliveryStatus", "QUEUED");
        actionPayload.put("note", "Demo outreach recorded without external delivery.");
        insertCaseAction(caseId, "OUTREACH_SENT", actor, actionPayload);
        insertOutreachRecord(
                caseId,
                "OUTREACH",
                "QUEUED",
                template == null ? "Default Template" : template.name(),
                false,
                actionPayload
        );

        Map<String, Object> auditPayload = new LinkedHashMap<>();
        auditPayload.put("caseStatus", "OPEN");
        auditPayload.put("nextAction", nextAction);
        auditPayload.put("outcomeStatus", existing.currentOutcomeStatus());
        auditPayload.put("action", actionPayload);
        insertAuditEvent(
                "CASE_OUTREACH_SENT",
                "case",
                caseId,
                actor,
                existing.lastRunId(),
                caseId,
                existing.measureVersionId(),
                auditPayload
        );

        return loadCase(caseId);
    }

    public Optional<CaseDetail> rerunToVerify(UUID caseId, String actor) {
        Optional<CaseContext> context = loadCaseContext(caseId);
        if (context.isEmpty()) {
            return Optional.empty();
        }

        CaseContext existing = context.get();
        UUID verificationRunId = createVerificationRun(existing.measureVersionId(), actor);
        String evaluationPeriod = existing.evaluationPeriod();

        Map<String, Object> verifiedEvidence = new LinkedHashMap<>();
        verifiedEvidence.put("source", "rerun-to-verify");
        verifiedEvidence.put("priorOutcomeStatus", existing.currentOutcomeStatus());
        verifiedEvidence.put("verifiedStatus", "COMPLIANT");
        verifiedEvidence.put("verifiedAt", Instant.now().toString());
        verifiedEvidence.put("note", "Demo verification run marked employee as compliant after outreach.");

        insertOutcome(
                verificationRunId,
                existing.employeeId(),
                existing.measureVersionId(),
                evaluationPeriod,
                "COMPLIANT",
                verifiedEvidence
        );

        insertCaseAction(
                caseId,
                "RERUN_TO_VERIFY",
                actor,
                Map.of(
                        "priorOutcomeStatus", existing.currentOutcomeStatus(),
                        "verifiedStatus", "COMPLIANT",
                        "runId", verificationRunId
                )
        );

        jdbcTemplate.update(
                "UPDATE cases SET status = ?, priority = ?, next_action = ?, current_outcome_status = ?, last_run_id = ?, updated_at = NOW(), closed_at = NOW(), closed_reason = ?, closed_by = ? WHERE id = ?",
                // MVP choice: compliant reruns move OPEN cases to RESOLVED.
                "RESOLVED",
                "LOW",
                "No follow-up needed after compliant verification rerun.",
                "COMPLIANT",
                verificationRunId,
                "RERUN_VERIFIED",
                actor,
                caseId
        );

        insertAuditEvent(
                "CASE_RERUN_VERIFIED",
                "case",
                caseId,
                actor,
                verificationRunId,
                caseId,
                existing.measureVersionId(),
                Map.of(
                        "priorOutcomeStatus", existing.currentOutcomeStatus(),
                        "verifiedStatus", "COMPLIANT",
                        "evaluationPeriod", evaluationPeriod
                )
        );

        insertAuditEvent(
                "CASE_RESOLVED",
                "case",
                caseId,
                actor,
                verificationRunId,
                caseId,
                existing.measureVersionId(),
                Map.of(
                        "status", "COMPLIANT",
                        "summary", "Case closed by rerun-to-verify after outreach."
                )
        );

        return loadCase(caseId);
    }

    public Optional<CaseDetail> resolveCase(UUID caseId, String actor, String note, Instant resolvedAt, String resolvedBy) {
        Optional<CaseContext> context = loadCaseContext(caseId);
        if (context.isEmpty()) {
            return Optional.empty();
        }

        CaseContext existing = context.get();
        if (!List.of("OPEN", "IN_PROGRESS").contains(existing.status())) {
            throw new IllegalArgumentException("Only OPEN or IN_PROGRESS cases can be manually resolved");
        }

        String trimmedNote = note == null ? "" : note.trim();
        if (trimmedNote.isBlank()) {
            throw new IllegalArgumentException("Closure note is required");
        }

        Instant effectiveResolvedAt = resolvedAt == null ? Instant.now() : resolvedAt;
        String effectiveResolvedBy = resolvedBy == null || resolvedBy.isBlank() ? actor : resolvedBy.trim();

        jdbcTemplate.update(
                "UPDATE cases SET status = ?, next_action = ?, updated_at = NOW(), closed_at = ?, closed_reason = ?, closed_by = ? WHERE id = ?",
                "CLOSED",
                "Manually resolved by case manager/admin.",
                Timestamp.from(effectiveResolvedAt),
                "MANUAL_RESOLVE",
                effectiveResolvedBy,
                caseId
        );

        Map<String, Object> actionPayload = new LinkedHashMap<>();
        actionPayload.put("type", "RESOLVE");
        actionPayload.put("note", trimmedNote);
        actionPayload.put("resolvedAt", effectiveResolvedAt.toString());
        actionPayload.put("resolvedBy", effectiveResolvedBy);
        insertCaseAction(caseId, "RESOLVE", actor, actionPayload);

        insertAuditEvent(
                "CASE_MANUALLY_CLOSED",
                "case",
                caseId,
                actor,
                existing.lastRunId(),
                caseId,
                existing.measureVersionId(),
                Map.of(
                        "caseId", caseId.toString(),
                        "note", trimmedNote,
                        "resolvedAt", effectiveResolvedAt.toString(),
                        "resolvedBy", effectiveResolvedBy,
                        "closedReason", "MANUAL_RESOLVE"
                )
        );

        return loadCase(caseId);
    }

    public Optional<CaseDetail> scheduleAppointment(
            UUID caseId,
            String actor,
            String appointmentType,
            Instant scheduledAt,
            String location,
            String notes
    ) {
        if (appointmentType == null || appointmentType.isBlank()) {
            throw new IllegalArgumentException("appointmentType is required");
        }
        if (scheduledAt == null) {
            throw new IllegalArgumentException("scheduledAt is required");
        }
        if (location == null || location.isBlank()) {
            throw new IllegalArgumentException("location is required");
        }

        Optional<CaseSchedulingContext> context = loadCaseSchedulingContext(caseId);
        if (context.isEmpty()) {
            return Optional.empty();
        }
        CaseSchedulingContext c = context.get();

        UUID appointmentId = UUID.randomUUID();
        jdbcTemplate.update(
                """
                        INSERT INTO scheduled_appointments (
                            id, case_id, employee_id, measure_id, appointment_type, scheduled_at, location, status, notes, created_by, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                        """,
                appointmentId,
                caseId,
                c.employeeId(),
                c.measureId(),
                appointmentType.trim(),
                Timestamp.from(scheduledAt),
                location.trim(),
                "PENDING",
                notes == null || notes.isBlank() ? null : notes.trim(),
                actor
        );

        Map<String, Object> actionPayload = new LinkedHashMap<>();
        actionPayload.put("type", "SCHEDULE_APPOINTMENT");
        actionPayload.put("appointmentId", appointmentId.toString());
        actionPayload.put("appointmentType", appointmentType.trim());
        actionPayload.put("scheduledAt", scheduledAt.toString());
        actionPayload.put("location", location.trim());
        actionPayload.put("notes", notes == null ? "" : notes.trim());
        insertCaseAction(caseId, "SCHEDULE_APPOINTMENT", actor, actionPayload);

        jdbcTemplate.update(
                """
                        INSERT INTO outreach_records (id, case_id, type, status, template_name, auto_triggered, payload_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, NOW())
                        """,
                UUID.randomUUID(),
                caseId,
                "APPOINTMENT_REMINDER",
                "QUEUED",
                "Appointment Confirmation",
                true,
                toJsonb(Map.of(
                        "appointmentId", appointmentId.toString(),
                        "scheduledAt", scheduledAt.toString(),
                        "location", location.trim()
                ))
        );

        if ("OPEN".equals(c.status())) {
            jdbcTemplate.update("UPDATE cases SET status = 'IN_PROGRESS', updated_at = NOW() WHERE id = ?", caseId);
        } else {
            jdbcTemplate.update("UPDATE cases SET updated_at = NOW() WHERE id = ?", caseId);
        }

        insertAuditEvent(
                "APPOINTMENT_SCHEDULED",
                "case",
                caseId,
                actor,
                c.lastRunId(),
                caseId,
                c.measureVersionId(),
                Map.of(
                        "appointmentId", appointmentId.toString(),
                        "appointmentType", appointmentType.trim(),
                        "scheduledAt", scheduledAt.toString(),
                        "location", location.trim()
                )
        );

        return loadCase(caseId);
    }

    public List<ScheduledAppointment> listAppointments(UUID caseId) {
        String sql = """
                SELECT id, case_id, employee_id, measure_id, appointment_type, scheduled_at, location, status, notes, created_by, created_at
                FROM scheduled_appointments
                WHERE case_id = ?
                ORDER BY scheduled_at DESC, created_at DESC
                """;
        return jdbcTemplate.query(sql, (rs, rowNum) -> new ScheduledAppointment(
                (UUID) rs.getObject("id"),
                (UUID) rs.getObject("case_id"),
                (UUID) rs.getObject("employee_id"),
                (UUID) rs.getObject("measure_id"),
                rs.getString("appointment_type"),
                toInstant(rs.getObject("scheduled_at")),
                rs.getString("location"),
                rs.getString("status"),
                rs.getString("notes"),
                rs.getString("created_by"),
                toInstant(rs.getObject("created_at"))
        ), caseId);
    }

    public Optional<CaseDetail> assignCase(UUID caseId, String assignee, String actor) {
        Optional<CaseContext> context = loadCaseContext(caseId);
        if (context.isEmpty()) {
            return Optional.empty();
        }
        String normalizedAssignee = assignee == null || assignee.isBlank() ? null : assignee.trim();
        CaseContext existing = context.get();
        jdbcTemplate.update(
                "UPDATE cases SET assignee = ?, updated_at = NOW() WHERE id = ?",
                normalizedAssignee,
                caseId
        );
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("assignee", normalizedAssignee == null ? "unassigned" : normalizedAssignee);
        payload.put("previousAssignee", existing.assignee() == null ? "unassigned" : existing.assignee());
        insertCaseAction(caseId, "ASSIGNED", actor, payload);
        insertAuditEvent(
                "CASE_ASSIGNED",
                "case",
                caseId,
                actor,
                existing.lastRunId(),
                caseId,
                existing.measureVersionId(),
                payload
        );
        return loadCase(caseId);
    }

    public Optional<CaseDetail> updateOutreachDelivery(UUID caseId, String deliveryStatus, String actor) {
        Optional<CaseContext> context = loadCaseContext(caseId);
        if (context.isEmpty()) {
            return Optional.empty();
        }
        if (!hasOutreachSentAction(caseId)) {
            throw new IllegalArgumentException("Cannot update delivery state before outreach is sent");
        }
        String normalized = normalizeDeliveryStatus(deliveryStatus);
        String nextAction = switch (normalized) {
            case "FAILED" -> "Retry outreach delivery or escalate if contact path remains blocked.";
            case "SENT" -> "Wait for employee response, then rerun to verify closure.";
            default -> "Outreach queued for delivery.";
        };
        jdbcTemplate.update("UPDATE cases SET next_action = ?, updated_at = NOW() WHERE id = ?", nextAction, caseId);

        Instant updatedAt = Instant.now();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("deliveryStatus", normalized);
        payload.put("updatedAt", updatedAt.toString());
        payload.put("actor", actor);
        payload.put("note", "Simulated delivery-state transition.");
        insertCaseAction(caseId, "OUTREACH_DELIVERY_UPDATED", actor, payload);

        CaseContext existing = context.get();
        insertAuditEvent(
                "CASE_OUTREACH_DELIVERY_UPDATED",
                "case",
                caseId,
                actor,
                existing.lastRunId(),
                caseId,
                existing.measureVersionId(),
                Map.of(
                        "caseId", caseId.toString(),
                        "deliveryStatus", normalized,
                        "updatedAt", updatedAt.toString(),
                        "actor", actor
                )
        );
        return loadCase(caseId);
    }

    public Optional<CaseDetail> escalateCase(UUID caseId, String actor) {
        Optional<CaseContext> context = loadCaseContext(caseId);
        if (context.isEmpty()) {
            return Optional.empty();
        }
        CaseContext existing = context.get();
        String escalationAction = "Escalated to supervisor queue for immediate handling.";
        jdbcTemplate.update(
                "UPDATE cases SET priority = ?, status = ?, next_action = ?, updated_at = NOW() WHERE id = ?",
                "HIGH",
                "OPEN",
                escalationAction,
                caseId
        );
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("priority", "HIGH");
        payload.put("status", "OPEN");
        payload.put("nextAction", escalationAction);
        payload.put("reason", "Manual escalation requested");
        insertCaseAction(caseId, "ESCALATED", actor, payload);
        insertAuditEvent(
                "CASE_ESCALATED",
                "case",
                caseId,
                actor,
                existing.lastRunId(),
                caseId,
                existing.measureVersionId(),
                payload
        );
        return loadCase(caseId);
    }

    private void upsertOpenCase(
            UUID runId,
            UUID measureVersionId,
            String evaluationPeriod,
            UUID employeeId,
            DemoOutcome outcome
    ) {
        String priority = priorityFor(outcome.outcome());
        String nextAction = nextActionFor(outcome.outcome(), measureVersionId);
        UUID candidateCaseId = UUID.randomUUID();
        Map<String, Object> upserted = jdbcTemplate.queryForMap(
                """
                        INSERT INTO cases (id, employee_id, measure_version_id, evaluation_period, status, priority, assignee, next_action, current_outcome_status, last_run_id, created_at, updated_at, closed_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NULL)
                        ON CONFLICT (employee_id, measure_version_id, evaluation_period)
                        DO UPDATE SET
                            status = EXCLUDED.status,
                            priority = EXCLUDED.priority,
                            next_action = EXCLUDED.next_action,
                            current_outcome_status = EXCLUDED.current_outcome_status,
                            last_run_id = EXCLUDED.last_run_id,
                            updated_at = NOW(),
                            closed_at = NULL,
                            closed_reason = NULL,
                            closed_by = NULL
                        RETURNING id, (xmax = 0) AS created
                        """,
                candidateCaseId,
                employeeId,
                measureVersionId,
                evaluationPeriod,
                "OPEN",
                priority,
                null,
                nextAction,
                outcome.outcome(),
                runId
        );
        UUID caseId = (UUID) upserted.get("id");
        boolean created = Boolean.TRUE.equals(upserted.get("created"));

        insertAuditEvent(
                created ? "CASE_CREATED" : "CASE_UPDATED",
                "case",
                caseId,
                "system",
                runId,
                caseId,
                measureVersionId,
                casePayload(outcome, priority, nextAction)
        );

        if (created) {
            queueAutoNotification(runId, caseId, measureVersionId, outcome);
        }
    }

    private void upsertExcludedCase(
            UUID runId,
            UUID measureVersionId,
            String evaluationPeriod,
            UUID employeeId,
            DemoOutcome outcome
    ) {
        String priority = priorityFor(outcome.outcome());
        String nextAction = nextActionFor(outcome.outcome(), measureVersionId);
        UUID candidateCaseId = UUID.randomUUID();
        Map<String, Object> upserted = jdbcTemplate.queryForMap(
                """
                        INSERT INTO cases (id, employee_id, measure_version_id, evaluation_period, status, priority, assignee, next_action, current_outcome_status, last_run_id, created_at, updated_at, closed_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NULL)
                        ON CONFLICT (employee_id, measure_version_id, evaluation_period)
                        DO UPDATE SET
                            status = EXCLUDED.status,
                            priority = EXCLUDED.priority,
                            next_action = EXCLUDED.next_action,
                            current_outcome_status = EXCLUDED.current_outcome_status,
                            last_run_id = EXCLUDED.last_run_id,
                            updated_at = NOW(),
                            closed_at = NULL,
                            closed_reason = NULL,
                            closed_by = NULL
                        RETURNING id, (xmax = 0) AS created
                        """,
                candidateCaseId,
                employeeId,
                measureVersionId,
                evaluationPeriod,
                "EXCLUDED",
                priority,
                null,
                nextAction,
                outcome.outcome(),
                runId
        );
        UUID caseId = (UUID) upserted.get("id");
        boolean created = Boolean.TRUE.equals(upserted.get("created"));

        String exclusionReason = outcome.summary();
        Optional<WaiverService.WaiverRecord> waiver = waiverService.ensureExclusionWaiver(
                employeeId,
                measureVersionId,
                exclusionReason,
                "system",
                "Auto-linked from excluded evaluation."
        );

        Map<String, Object> payload = new LinkedHashMap<>(casePayload(outcome, priority, nextAction));
        payload.put("status", "EXCLUDED");
        payload.put("created", created);
        payload.put("waiverId", waiver.map(record -> record.waiverId().toString()).orElse(null));
        payload.put("exclusionReason", waiver.map(WaiverService.WaiverRecord::exclusionReason).orElse(exclusionReason));
        payload.put("waiverExpiresAt", waiver.flatMap(record -> Optional.ofNullable(record.expiresAt())).map(Instant::toString).orElse(null));
        payload.put("waiverExpired", waiver.map(WaiverService.WaiverRecord::expired).orElse(false));

        insertAuditEvent(
                "CASE_EXCLUDED",
                "case",
                caseId,
                "system",
                runId,
                caseId,
                measureVersionId,
                payload
        );
    }

    private void closeExistingCaseIfNeeded(
            UUID runId,
            UUID measureVersionId,
            String evaluationPeriod,
            UUID employeeId,
            DemoOutcome outcome
    ) {
        Optional<UUID> existingCaseId = findCaseId(employeeId, measureVersionId, evaluationPeriod);
        if (existingCaseId.isEmpty()) {
            return;
        }

        UUID caseId = existingCaseId.get();
        jdbcTemplate.update(
                "UPDATE cases SET status = ?, priority = ?, next_action = ?, current_outcome_status = ?, last_run_id = ?, updated_at = NOW(), closed_at = NOW(), closed_reason = ?, closed_by = ? WHERE id = ?",
                "RESOLVED",
                "LOW",
                "Resolved by compliant rerun.",
                outcome.outcome(),
                runId,
                "AUTO_RESOLVE",
                "system",
                caseId
        );

        insertAuditEvent(
                "CASE_RESOLVED",
                "case",
                caseId,
                "system",
                runId,
                caseId,
                measureVersionId,
                casePayload(outcome, "LOW", "Resolved by compliant rerun.")
        );
    }

    private Optional<UUID> findCaseId(UUID employeeId, UUID measureVersionId, String evaluationPeriod) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(
                    "SELECT id FROM cases WHERE employee_id = ? AND measure_version_id = ? AND evaluation_period = ?",
                    UUID.class,
                    employeeId,
                    measureVersionId,
                    evaluationPeriod
            ));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    private Optional<CaseContext> loadCaseContext(UUID caseId) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(
                    """
                            SELECT id, employee_id, measure_version_id, evaluation_period, status, current_outcome_status, last_run_id, assignee
                            FROM cases
                            WHERE id = ?
                            """,
                    (rs, rowNum) -> new CaseContext(
                            (UUID) rs.getObject("id"),
                            (UUID) rs.getObject("employee_id"),
                            (UUID) rs.getObject("measure_version_id"),
                            rs.getString("evaluation_period"),
                            rs.getString("status"),
                            rs.getString("current_outcome_status"),
                            (UUID) rs.getObject("last_run_id"),
                            rs.getString("assignee")
                    ),
                    caseId
            ));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    private Optional<CaseSchedulingContext> loadCaseSchedulingContext(UUID caseId) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(
                    """
                            SELECT c.id,
                                   c.employee_id,
                                   c.measure_version_id,
                                   c.status,
                                   c.last_run_id,
                                   m.id AS measure_id
                            FROM cases c
                            JOIN measure_versions mv ON c.measure_version_id = mv.id
                            JOIN measures m ON mv.measure_id = m.id
                            WHERE c.id = ?
                            """,
                    (rs, rowNum) -> new CaseSchedulingContext(
                            (UUID) rs.getObject("id"),
                            (UUID) rs.getObject("employee_id"),
                            (UUID) rs.getObject("measure_version_id"),
                            (UUID) rs.getObject("measure_id"),
                            rs.getString("status"),
                            (UUID) rs.getObject("last_run_id")
                    ),
                    caseId
            ));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    private String findLatestOutreachDeliveryStatus(UUID caseId) {
        return jdbcTemplate.query(
                """
                        SELECT payload_json ->> 'deliveryStatus' AS delivery_status
                        FROM case_actions
                        WHERE case_id = ?
                          AND action_type = 'OUTREACH_DELIVERY_UPDATED'
                        ORDER BY performed_at DESC
                        LIMIT 1
                        """,
                rs -> rs.next() ? rs.getString("delivery_status") : null,
                caseId
        );
    }

    private boolean hasOutreachSentAction(UUID caseId) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM case_actions WHERE case_id = ? AND action_type = 'OUTREACH_SENT'",
                Integer.class,
                caseId
        );
        return count != null && count > 0;
    }

    private UUID createVerificationRun(UUID measureVersionId, String actor) {
        UUID runId = UUID.randomUUID();
        Instant now = Instant.now();
        jdbcTemplate.update(
                "INSERT INTO runs (id, scope_type, scope_id, site, trigger_type, status, triggered_by, started_at, completed_at, total_evaluated, compliant, non_compliant, duration_ms, measurement_period_start, measurement_period_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ps -> {
                    ps.setObject(1, runId);
                    ps.setString(2, "case");
                    ps.setObject(3, measureVersionId);
                    ps.setString(4, "demo");
                    ps.setString(5, "manual");
                    ps.setString(6, "completed");
                    ps.setString(7, actor);
                    ps.setObject(8, java.sql.Timestamp.from(now));
                    ps.setObject(9, java.sql.Timestamp.from(now.plusSeconds(5)));
                    ps.setInt(10, 1);
                    ps.setInt(11, 1);
                    ps.setInt(12, 0);
                    ps.setLong(13, 5_000L);
                    ps.setObject(14, java.sql.Timestamp.from(now));
                    ps.setObject(15, java.sql.Timestamp.from(now.plusSeconds(5)));
                }
        );
        jdbcTemplate.update(
                "INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)",
                runId,
                "INFO",
                "Case-level rerun-to-verify executed."
        );
        insertAuditEvent(
                "RUN_STARTED",
                "run",
                runId,
                actor,
                runId,
                null,
                measureVersionId,
                Map.of("scope", "case", "source", "rerun-to-verify")
        );
        insertAuditEvent(
                "RUN_COMPLETED",
                "run",
                runId,
                actor,
                runId,
                null,
                measureVersionId,
                Map.of("scope", "case", "source", "rerun-to-verify", "totalEvaluated", 1, "compliant", 1)
        );
        return runId;
    }

    private void insertOutcome(
            UUID runId,
            UUID employeeId,
            UUID measureVersionId,
            String evaluationPeriod,
            String status,
            Map<String, Object> evidence
    ) {
        UUID outcomeId = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO outcomes (id, run_id, employee_id, measure_version_id, evaluation_period, status, evidence_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, NOW())",
                outcomeId,
                runId,
                employeeId,
                measureVersionId,
                evaluationPeriod,
                status,
                toJsonb(evidence)
        );

        insertAuditEvent(
                "OUTCOME_PERSISTED",
                "outcome",
                outcomeId,
                "system",
                runId,
                null,
                measureVersionId,
                Map.of(
                        "status", status,
                        "source", "case-rerun-verify"
                )
        );
    }

    private void insertCaseAction(UUID caseId, String actionType, String actor, Map<String, Object> payload) {
        jdbcTemplate.update(
                "INSERT INTO case_actions (id, case_id, action_type, payload_json, performed_by) VALUES (?, ?, ?, ?::jsonb, ?)",
                UUID.randomUUID(),
                caseId,
                actionType,
                toJsonb(payload),
                actor
        );
    }

    private List<AuditEvent> loadCaseTimeline(UUID caseId) {
        String sql = """
                SELECT event_type,
                       actor,
                       occurred_at,
                       payload_json,
                       timeline_source,
                       sort_key
                FROM (
                    SELECT event_type,
                           actor,
                           occurred_at,
                           payload_json,
                           'audit_event' AS timeline_source,
                           id::text AS sort_key
                    FROM audit_events
                    WHERE ref_case_id = ?
                      AND event_type <> 'CASE_VIEWED'
                    UNION ALL
                    SELECT action_type AS event_type,
                           performed_by AS actor,
                           performed_at AS occurred_at,
                           payload_json,
                           'case_action' AS timeline_source,
                           id::text AS sort_key
                    FROM case_actions
                    WHERE case_id = ?
                ) timeline
                ORDER BY occurred_at ASC, sort_key ASC
                """;

        return jdbcTemplate.query(sql, rs -> {
            List<AuditEvent> timeline = new ArrayList<>();
            while (rs.next()) {
                Map<String, Object> payload = rs.getString("payload_json") == null
                        ? new LinkedHashMap<>()
                        : new LinkedHashMap<>(readJsonPayload(rs.getString("payload_json")));
                payload.put("timelineSource", rs.getString("timeline_source"));
                timeline.add(new AuditEvent(
                        rs.getString("event_type"),
                        rs.getString("actor"),
                        toInstant(rs.getObject("occurred_at")),
                        payload
                ));
            }
            return timeline;
        }, caseId, caseId);
    }

    private boolean requiresOpenCase(String outcome) {
        return switch (outcome) {
            case "DUE_SOON", "OVERDUE", "MISSING_DATA" -> true;
            default -> false;
        };
    }

    private String priorityFor(String outcome) {
        return switch (outcome) {
            case "OVERDUE" -> "HIGH";
            case "MISSING_DATA" -> "MEDIUM";
            case "DUE_SOON" -> "MEDIUM";
            default -> "LOW";
        };
    }

    private String nextActionFor(String outcome, UUID measureVersionId) {
        String measureName = measureNameFor(measureVersionId);
        String label = switch (measureName) {
            case "TB Surveillance" -> "TB screening";
            case "HAZWOPER Surveillance" -> "HAZWOPER surveillance";
            case "Flu Vaccine" -> "flu vaccine";
            default -> "audiogram";
        };
        return switch (outcome) {
            case "OVERDUE" -> "Escalate " + label + " follow-up immediately.";
            case "MISSING_DATA" -> "Collect the missing " + label + " documentation.";
            case "DUE_SOON" -> "Schedule the annual " + label + " before the due date.";
            case "EXCLUDED" -> "Review the active waiver and rerun before it expires.";
            default -> "No action required.";
        };
    }

    private void queueAutoNotification(UUID runId, UUID caseId, UUID measureVersionId, DemoOutcome outcome) {
        String measureName = measureNameFor(measureVersionId);
        String templateName = autoNotificationTemplateName(outcome.outcome(), measureName);
        OutreachTemplateService.OutreachTemplate template = outreachTemplateService.resolveByNameOrDefault(templateName);
        if (template == null) {
            return;
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("autoTriggered", true);
        payload.put("outcomeStatus", outcome.outcome());
        payload.put("measureName", measureName);
        payload.put("templateId", template.id());
        payload.put("templateName", template.name());
        payload.put("subject", template.subject());
        payload.put("nextAction", nextActionFor(outcome.outcome(), measureVersionId));
        payload.put("note", "Auto-queued outreach created during case upsert.");

        insertOutreachRecord(caseId, "OUTREACH", "QUEUED", template.name(), true, payload);
        insertAuditEvent(
                "NOTIFICATION_AUTO_QUEUED",
                "case",
                caseId,
                "system",
                runId,
                caseId,
                measureVersionId,
                payload
        );
    }

    private void insertOutreachRecord(
            UUID caseId,
            String type,
            String status,
            String templateName,
            boolean autoTriggered,
            Map<String, Object> payload
    ) {
        jdbcTemplate.update(
                """
                        INSERT INTO outreach_records (id, case_id, type, status, template_name, auto_triggered, payload_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, NOW())
                        """,
                UUID.randomUUID(),
                caseId,
                type,
                status,
                templateName,
                autoTriggered,
                toJsonb(payload)
        );
    }

    private String measureNameFor(UUID measureVersionId) {
        return jdbcTemplate.queryForObject(
                """
                        SELECT m.name
                        FROM measure_versions mv
                        JOIN measures m ON mv.measure_id = m.id
                        WHERE mv.id = ?
                        """,
                String.class,
                measureVersionId
        );
    }

    private String autoNotificationTemplateName(String outcome, String measureName) {
        String normalizedMeasure = measureName == null ? "" : measureName.toLowerCase(Locale.ROOT);
        return switch (outcome) {
            case "MISSING_DATA" -> "Missing Data Follow-Up";
            case "DUE_SOON" -> {
                if (normalizedMeasure.contains("audiogram") || normalizedMeasure.contains("hearing")) {
                    yield "Hearing Conservation Overdue Outreach";
                }
                if (normalizedMeasure.contains("tb")) {
                    yield "TB Surveillance Follow-Up";
                }
                yield "General Compliance Reminder";
            }
            case "OVERDUE" -> "General Compliance Reminder";
            default -> "General Compliance Reminder";
        };
    }

    private String normalizeDeliveryStatus(String deliveryStatus) {
        if (deliveryStatus == null || deliveryStatus.isBlank()) {
            throw new IllegalArgumentException("deliveryStatus is required");
        }
        String normalized = deliveryStatus.trim().toUpperCase();
        if (!List.of("QUEUED", "SENT", "FAILED").contains(normalized)) {
            throw new IllegalArgumentException("deliveryStatus must be one of QUEUED, SENT, FAILED");
        }
        return normalized;
    }

    @SuppressWarnings("unchecked")
    private String computeDueDate(CaseDetail detail) {
        try {
            Object whyObj = detail.evidenceJson().get("why_flagged");
            if (!(whyObj instanceof Map<?, ?> why)) {
                return detail.evaluationPeriod();
            }
            Object lastExamObj = why.get("last_exam_date");
            Object windowObj = why.get("compliance_window_days");
            if (lastExamObj == null || windowObj == null) {
                return detail.evaluationPeriod();
            }
            java.time.LocalDate lastExam = java.time.LocalDate.parse(lastExamObj.toString());
            int windowDays = Integer.parseInt(windowObj.toString());
            return lastExam.plusDays(windowDays).toString();
        } catch (Exception ignored) {
            return detail.evaluationPeriod();
        }
    }

    private String renderTemplate(
            String raw,
            String employeeName,
            String measureName,
            String dueDate,
            String outcomeStatus
    ) {
        if (raw == null) {
            return "";
        }
        return raw
                .replace("{{employeeName}}", employeeName == null ? "" : employeeName)
                .replace("{{measureName}}", measureName == null ? "" : measureName)
                .replace("{{dueDate}}", dueDate == null ? "" : dueDate)
                .replace("{{outcomeStatus}}", outcomeStatus == null ? "" : outcomeStatus);
    }

    private Map<String, Object> casePayload(DemoOutcome outcome, String priority, String nextAction) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subjectId", outcome.subjectId());
        payload.put("status", outcome.outcome());
        payload.put("summary", outcome.summary());
        payload.put("priority", priority);
        payload.put("nextAction", nextAction);
        return payload;
    }

    private void insertAuditEvent(
            String eventType,
            String entityType,
            UUID entityId,
            String actor,
            UUID refRunId,
            UUID refCaseId,
            UUID refMeasureVersionId,
            Map<String, Object> payload
    ) {
        String resolvedActor = SecurityActor.currentActorOr(actor);
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, ref_measure_version_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)",
                ps -> {
                    ps.setString(1, eventType);
                    ps.setString(2, entityType);
                    ps.setObject(3, entityId);
                    ps.setString(4, resolvedActor);
                    ps.setObject(5, refRunId);
                    ps.setObject(6, refCaseId);
                    ps.setObject(7, refMeasureVersionId);
                    ps.setString(8, toJsonb(payload));
                }
        );
    }

    private String toJsonb(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialise JSON payload", ex);
        }
    }

    private Map<String, Object> readJson(String json) {
        try {
            return objectMapper.readValue(json, Map.class);
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to parse JSON payload", ex);
        }
    }

    private Map<String, Object> readJsonPayload(String json) {
        try {
            Object decoded = objectMapper.readValue(json, Object.class);
            if (decoded instanceof Map<?, ?> map) {
                Map<String, Object> payload = new LinkedHashMap<>();
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    payload.put(String.valueOf(entry.getKey()), entry.getValue());
                }
                return payload;
            }
            return new LinkedHashMap<>(Map.of("value", decoded));
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to parse JSON payload", ex);
        }
    }

    private Instant toInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof java.sql.Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        throw new IllegalStateException("Unexpected timestamp value type: " + value.getClass());
    }

    private String outcomeSummaryFor(String outcome) {
        return switch (outcome) {
            case "COMPLIANT" -> "Measure outcome is compliant for the current window.";
            case "DUE_SOON" -> "Measure outcome is due soon within the compliance window.";
            case "OVERDUE" -> "Measure outcome is overdue and requires follow-up.";
            case "MISSING_DATA" -> "Measure outcome could not be evaluated due to missing data.";
            case "EXCLUDED" -> "Measure outcome is excluded due to documented exemption/waiver.";
            default -> "Unknown status.";
        };
    }

    public record CaseSummary(
            UUID caseId,
            String employeeId,
            String employeeName,
            String site,
            UUID measureVersionId,
            String measureName,
            String measureVersion,
            String evaluationPeriod,
            String status,
            String priority,
            String assignee,
            String currentOutcomeStatus,
            UUID lastRunId,
            String exclusionReason,
            Instant waiverExpiresAt,
            boolean waiverExpired,
            int outreachRecordCount,
            Instant updatedAt
    ) {
    }

    public record CaseDetail(
            UUID caseId,
            String employeeId,
            String employeeName,
            String measureName,
            UUID measureVersionId,
            String measureVersion,
            String evaluationPeriod,
            String status,
            String priority,
            String assignee,
            String nextAction,
            String currentOutcomeStatus,
            UUID lastRunId,
            Instant createdAt,
            Instant updatedAt,
            Instant closedAt,
            String closedReason,
            String closedBy,
            String exclusionReason,
            Instant waiverExpiresAt,
            boolean waiverExpired,
            Map<String, Object> evidenceJson,
            String outcomeStatus,
            String outcomeSummary,
            Instant outcomeEvaluatedAt,
            String latestOutreachDeliveryStatus,
            List<AuditEvent> timeline
    ) {
    }

    public record OutreachPreview(
            UUID templateId,
            String templateName,
            String subject,
            String bodyText,
            String employeeName,
            String measureName,
            String dueDate
    ) {
    }

    public record AuditEvent(
            String eventType,
            String actor,
            Instant occurredAt,
            Map<String, Object> payload
    ) {
    }

    public record ScheduledAppointment(
            UUID id,
            UUID caseId,
            UUID employeeId,
            UUID measureId,
            String appointmentType,
            Instant scheduledAt,
            String location,
            String status,
            String notes,
            String createdBy,
            Instant createdAt
    ) {
    }

    private record CaseContext(
            UUID caseId,
            UUID employeeId,
            UUID measureVersionId,
            String evaluationPeriod,
            String status,
            String currentOutcomeStatus,
            UUID lastRunId,
            String assignee
    ) {
    }

    private record CaseSchedulingContext(
            UUID caseId,
            UUID employeeId,
            UUID measureVersionId,
            UUID measureId,
            String status,
            UUID lastRunId
    ) {
    }
}
