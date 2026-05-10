package com.workwell.audit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.admin.DataReadinessService;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.caseflow.EvidenceService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.MeasureTraceabilityService;
import com.workwell.measure.ValueSetGovernanceService;
import com.workwell.run.RunPersistenceService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AuditPacketService {

    private static final List<String> CASE_DISCLAIMERS = List.of(
            "Compliance status is determined solely by CQL evaluation logic, not by AI-generated explanations.",
            "AI-generated explanation text, if present, is assistive only and does not constitute a compliance determination.",
            "This packet reflects WorkWell Measure Studio data as of the generation timestamp.",
            "Evidence files are referenced by metadata only; raw file bytes are not included in this packet."
    );
    private static final List<String> RUN_DISCLAIMERS = List.of(
            "Compliance outcomes are determined by CQL evaluation logic only.",
            "This packet reflects WorkWell Measure Studio data as of the generation timestamp.",
            "AI-generated run insights, if present, are assistive only and do not constitute compliance determinations."
    );
    private static final List<String> MEASURE_DISCLAIMERS = List.of(
            "CQL text is included as a reference artifact. All compliance determinations are made by evaluating CQL at runtime.",
            "Traceability and data readiness information reflects the state at packet generation time.",
            "Value set governance data reflects the most recently resolved state.",
            "This packet reflects WorkWell Measure Studio data as of the generation timestamp."
    );

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final CaseFlowService caseFlowService;
    private final EvidenceService evidenceService;
    private final RunPersistenceService runPersistenceService;
    private final MeasureService measureService;
    private final MeasureTraceabilityService traceabilityService;
    private final DataReadinessService dataReadinessService;
    private final ValueSetGovernanceService valueSetGovernanceService;

    public AuditPacketService(
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper,
            CaseFlowService caseFlowService,
            EvidenceService evidenceService,
            RunPersistenceService runPersistenceService,
            MeasureService measureService,
            MeasureTraceabilityService traceabilityService,
            DataReadinessService dataReadinessService,
            ValueSetGovernanceService valueSetGovernanceService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        this.caseFlowService = caseFlowService;
        this.evidenceService = evidenceService;
        this.runPersistenceService = runPersistenceService;
        this.measureService = measureService;
        this.traceabilityService = traceabilityService;
        this.dataReadinessService = dataReadinessService;
        this.valueSetGovernanceService = valueSetGovernanceService;
    }

    public PacketResult buildCasePacket(UUID caseId, String actor, String format) {
        CaseFlowService.CaseDetail detail = caseFlowService.loadCase(caseId)
                .orElseThrow(() -> new IllegalArgumentException("Case not found: " + caseId));

        List<CaseFlowService.ScheduledAppointment> appointments = caseFlowService.listAppointments(caseId);
        List<EvidenceService.EvidenceAttachment> attachments = evidenceService.list(caseId);
        List<Map<String, Object>> outreach = queryOutreachRecords(caseId);

        List<Map<String, Object>> auditEvents = new ArrayList<>();
        List<Map<String, Object>> actions = new ArrayList<>();
        List<Map<String, Object>> aiAssistance = new ArrayList<>();

        for (CaseFlowService.AuditEvent event : detail.timeline()) {
            String source = String.valueOf(event.payload().getOrDefault("timelineSource", ""));
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("eventType", event.eventType());
            entry.put("actor", event.actor());
            entry.put("occurredAt", event.occurredAt() == null ? null : event.occurredAt().toString());
            Map<String, Object> payload = new LinkedHashMap<>(event.payload());
            payload.remove("timelineSource");
            entry.put("payload", payload);
            if ("case_action".equals(source)) {
                actions.add(entry);
            } else if (event.eventType() != null && event.eventType().startsWith("AI_")) {
                aiAssistance.add(entry);
            } else {
                auditEvents.add(entry);
            }
        }

        Map<String, Object> packet = new LinkedHashMap<>();
        packet.put("packetType", "CASE");
        packet.put("generatedAt", Instant.now().toString());
        packet.put("generatedBy", actor);
        packet.put("case", buildCaseSection(detail));
        packet.put("employee", buildEmployeeSection(detail));
        packet.put("measure", buildMeasureSectionForCase(detail));
        packet.put("decisionEvidence", buildEvidenceSection(detail));
        packet.put("actions", actions);
        packet.put("outreach", outreach);
        packet.put("appointments", appointmentMaps(appointments));
        packet.put("attachments", attachmentMaps(attachments));
        packet.put("auditEvents", auditEvents);
        packet.put("aiAssistance", aiAssistance);
        packet.put("disclaimers", CASE_DISCLAIMERS);

        return buildResult(packet, "CASE", caseId, actor, format, null, null);
    }

    public PacketResult buildRunPacket(UUID runId, String actor, String format) {
        RunPersistenceService.RunSummaryResponse run = runPersistenceService.loadRunById(runId)
                .orElseThrow(() -> new IllegalArgumentException("Run not found: " + runId));

        List<RunPersistenceService.RunLogEntry> logs = runPersistenceService.loadRunLogs(runId, 200);
        List<RunPersistenceService.RunOutcomeRow> outcomes = runPersistenceService.loadRunOutcomes(runId);
        List<Map<String, Object>> auditEvents = queryAuditEventsByRun(runId);

        Map<String, Object> packet = new LinkedHashMap<>();
        packet.put("packetType", "RUN");
        packet.put("generatedAt", Instant.now().toString());
        packet.put("generatedBy", actor);
        packet.put("run", buildRunSection(run));
        packet.put("summary", buildSummarySection(run));
        packet.put("outcomes", outcomeMaps(outcomes));
        packet.put("runLogs", logMaps(logs));
        packet.put("auditEvents", auditEvents);
        packet.put("disclaimers", RUN_DISCLAIMERS);

        return buildResult(packet, "RUN", runId, actor, format, runId, null);
    }

    public PacketResult buildMeasureVersionPacket(UUID measureVersionId, String actor, String format) {
        UUID measureId = lookupMeasureIdByVersion(measureVersionId);
        MeasureService.MeasureDetail detail = measureService.getMeasure(measureId);
        if (detail == null) {
            throw new IllegalArgumentException("Measure not found for version: " + measureVersionId);
        }

        MeasureTraceabilityService.TraceabilityResponse traceability = tryGetTraceability(measureId);
        DataReadinessService.DataReadinessResponse readiness = tryGetDataReadiness(measureId);
        ValueSetGovernanceService.ResolveCheckResult vsGovernance = tryGetVsGovernance(measureId);
        List<Map<String, Object>> auditEvents = queryAuditEventsByMeasureVersion(measureVersionId);
        List<Map<String, Object>> approvalHistory = filterApprovalHistory(auditEvents);

        String cqlText = detail.cqlText() == null ? "" : detail.cqlText();
        String cqlHash = cqlText.isBlank() ? "" : computeHash(cqlText.getBytes(StandardCharsets.UTF_8));

        Map<String, Object> packet = new LinkedHashMap<>();
        packet.put("packetType", "MEASURE_VERSION");
        packet.put("generatedAt", Instant.now().toString());
        packet.put("generatedBy", actor);
        packet.put("measure", buildMeasureDetailSection(detail, measureVersionId));
        packet.put("spec", buildSpecSection(detail));
        packet.put("cql", Map.of("text", cqlText, "hash", cqlHash));
        packet.put("compileStatus", detail.compileStatus());
        packet.put("valueSets", valueSetMaps(detail.valueSets()));
        packet.put("valueSetGovernance", vsGovernance != null ? safeConvert(vsGovernance) : Map.of());
        packet.put("testFixtures", testFixtureMaps(detail.testFixtures()));
        packet.put("traceability", traceability != null ? safeConvert(traceability) : Map.of());
        packet.put("dataReadiness", readiness != null ? safeConvert(readiness) : Map.of());
        packet.put("approvalHistory", approvalHistory);
        packet.put("auditEvents", auditEvents);
        packet.put("disclaimers", MEASURE_DISCLAIMERS);

        return buildResult(packet, "MEASURE_VERSION", measureVersionId, actor, format, null, measureVersionId);
    }

    private PacketResult buildResult(
            Map<String, Object> packet,
            String packetType,
            UUID entityId,
            String actor,
            String format,
            UUID refRunId,
            UUID refMeasureVersionId
    ) {
        byte[] jsonBytes = serialize(packet);
        String hash = "sha256:" + computeHash(jsonBytes);

        writeAuditEvent(entityId, packetType, actor, format, jsonBytes.length, hash, refRunId, refMeasureVersionId);
        insertExportRecord(entityId, packetType, actor, format, jsonBytes.length, hash);

        if ("html".equalsIgnoreCase(format)) {
            byte[] htmlBytes = renderHtml(packet).getBytes(StandardCharsets.UTF_8);
            return new PacketResult(
                    htmlBytes,
                    "text/html",
                    "workwell-" + packetType.toLowerCase().replace('_', '-') + "-packet-" + entityId + ".html"
            );
        }
        return new PacketResult(
                jsonBytes,
                "application/json",
                "workwell-" + packetType.toLowerCase().replace('_', '-') + "-packet-" + entityId + ".json"
        );
    }

    private void writeAuditEvent(
            UUID entityId,
            String packetType,
            String actor,
            String format,
            long sizeBytes,
            String hash,
            UUID refRunId,
            UUID refMeasureVersionId
    ) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("packetType", packetType);
        payload.put("entityId", entityId.toString());
        payload.put("format", format);
        payload.put("sizeBytes", sizeBytes);
        payload.put("payloadHash", hash);
        payload.put("generatedAt", Instant.now().toString());
        payload.put("generatedBy", actor);
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_run_id, ref_measure_version_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)",
                "AUDIT_PACKET_GENERATED",
                "audit_packet",
                entityId,
                actor,
                refRunId,
                refMeasureVersionId,
                toJsonb(payload)
        );
    }

    private void insertExportRecord(
            UUID entityId,
            String packetType,
            String actor,
            String format,
            long sizeBytes,
            String hash
    ) {
        jdbcTemplate.update(
                "INSERT INTO audit_packet_exports (packet_type, entity_id, format, generated_by, generated_at, payload_hash, payload_size_bytes) VALUES (?, ?, ?, ?, NOW(), ?, ?)",
                packetType,
                entityId,
                format,
                actor,
                hash,
                sizeBytes
        );
    }

    private Map<String, Object> buildCaseSection(CaseFlowService.CaseDetail detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("caseId", detail.caseId().toString());
        m.put("status", detail.status());
        m.put("priority", detail.priority());
        m.put("currentOutcomeStatus", detail.currentOutcomeStatus());
        m.put("evaluationPeriod", detail.evaluationPeriod());
        m.put("assignee", detail.assignee());
        m.put("nextAction", detail.nextAction());
        m.put("createdAt", detail.createdAt() == null ? null : detail.createdAt().toString());
        m.put("updatedAt", detail.updatedAt() == null ? null : detail.updatedAt().toString());
        m.put("closedAt", detail.closedAt() == null ? null : detail.closedAt().toString());
        m.put("closedReason", detail.closedReason());
        m.put("closedBy", detail.closedBy());
        m.put("exclusionReason", detail.exclusionReason());
        m.put("waiverExpiresAt", detail.waiverExpiresAt() == null ? null : detail.waiverExpiresAt().toString());
        m.put("waiverExpired", detail.waiverExpired());
        m.put("lastRunId", detail.lastRunId() == null ? null : detail.lastRunId().toString());
        return m;
    }

    private Map<String, Object> buildEmployeeSection(CaseFlowService.CaseDetail detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("externalId", detail.employeeId());
        m.put("name", detail.employeeName());
        return m;
    }

    private Map<String, Object> buildMeasureSectionForCase(CaseFlowService.CaseDetail detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("measureVersionId", detail.measureVersionId() == null ? null : detail.measureVersionId().toString());
        m.put("name", detail.measureName());
        m.put("version", detail.measureVersion());
        m.put("outcomeSummary", detail.outcomeSummary());
        return m;
    }

    private Map<String, Object> buildEvidenceSection(CaseFlowService.CaseDetail detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("outcomeStatus", detail.outcomeStatus());
        m.put("outcomeSummary", detail.outcomeSummary());
        m.put("outcomeEvaluatedAt", detail.outcomeEvaluatedAt() == null ? null : detail.outcomeEvaluatedAt().toString());
        Map<String, Object> evidence = detail.evidenceJson() == null ? Map.of() : detail.evidenceJson();
        m.put("whyFlagged", evidence.getOrDefault("why_flagged", Map.of()));
        m.put("expressionResults", evidence.getOrDefault("expressionResults", List.of()));
        return m;
    }

    private Map<String, Object> buildRunSection(RunPersistenceService.RunSummaryResponse run) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("runId", run.runId());
        m.put("measureName", run.measureName());
        m.put("measureVersion", run.measureVersion());
        m.put("status", run.status());
        m.put("triggerType", run.triggerType());
        m.put("scopeType", run.scopeType());
        m.put("startedAt", run.startedAt() == null ? null : run.startedAt().toString());
        m.put("completedAt", run.completedAt() == null ? null : run.completedAt().toString());
        m.put("durationMs", run.durationMs());
        return m;
    }

    private Map<String, Object> buildSummarySection(RunPersistenceService.RunSummaryResponse run) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("totalEvaluated", run.totalEvaluated());
        m.put("compliant", run.compliantCount());
        m.put("nonCompliant", run.nonCompliantCount());
        m.put("passRate", run.passRate());
        m.put("totalCases", run.totalCases());
        m.put("outcomeCounts", run.outcomeCounts());
        m.put("dataFreshAsOf", run.dataFreshAsOf() == null ? null : run.dataFreshAsOf().toString());
        return m;
    }

    private Map<String, Object> buildMeasureDetailSection(MeasureService.MeasureDetail detail, UUID measureVersionId) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("measureId", detail.id() == null ? null : detail.id().toString());
        m.put("measureVersionId", measureVersionId == null ? null : measureVersionId.toString());
        m.put("name", detail.name());
        m.put("version", detail.version());
        m.put("status", detail.status());
        m.put("owner", detail.owner());
        m.put("policyRef", detail.policyRef());
        m.put("tags", detail.tags());
        m.put("lastUpdated", detail.lastUpdated() == null ? null : detail.lastUpdated().toString());
        return m;
    }

    private Map<String, Object> buildSpecSection(MeasureService.MeasureDetail detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("description", detail.description());
        m.put("complianceWindow", detail.complianceWindow());
        m.put("requiredDataElements", detail.requiredDataElements());
        m.put("exclusions", detail.exclusions());
        MeasureService.EligibilityCriteria ec = detail.eligibilityCriteria();
        if (ec != null) {
            m.put("eligibilityCriteria", Map.of(
                    "roleFilter", ec.roleFilter() == null ? "" : ec.roleFilter(),
                    "siteFilter", ec.siteFilter() == null ? "" : ec.siteFilter(),
                    "programEnrollmentText", ec.programEnrollmentText() == null ? "" : ec.programEnrollmentText()
            ));
        }
        return m;
    }

    private List<Map<String, Object>> appointmentMaps(List<CaseFlowService.ScheduledAppointment> appointments) {
        return appointments.stream().map(a -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", a.id() == null ? null : a.id().toString());
            m.put("appointmentType", a.appointmentType());
            m.put("scheduledAt", a.scheduledAt() == null ? null : a.scheduledAt().toString());
            m.put("location", a.location());
            m.put("status", a.status());
            m.put("notes", a.notes());
            m.put("createdBy", a.createdBy());
            return m;
        }).toList();
    }

    private List<Map<String, Object>> attachmentMaps(List<EvidenceService.EvidenceAttachment> attachments) {
        return attachments.stream().map(a -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("evidenceId", a.id() == null ? null : a.id().toString());
            m.put("filename", a.fileName());
            m.put("contentType", a.mimeType());
            m.put("sizeBytes", a.fileSizeBytes());
            m.put("uploadedBy", a.uploadedBy());
            m.put("uploadedAt", a.uploadedAt() == null ? null : a.uploadedAt().toString());
            m.put("description", a.description());
            return m;
        }).toList();
    }

    private List<Map<String, Object>> outcomeMaps(List<RunPersistenceService.RunOutcomeRow> outcomes) {
        return outcomes.stream().map(o -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("employeeName", o.employeeName());
            m.put("employeeExternalId", o.employeeExternalId());
            m.put("role", o.role());
            m.put("site", o.site());
            m.put("outcomeStatus", o.outcomeStatus());
            m.put("daysSinceExam", o.daysSinceExam());
            m.put("waiverStatus", o.waiverStatus());
            m.put("caseId", o.caseId());
            return m;
        }).toList();
    }

    private List<Map<String, Object>> logMaps(List<RunPersistenceService.RunLogEntry> logs) {
        return logs.stream().map(l -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("timestamp", l.timestamp() == null ? null : l.timestamp().toString());
            m.put("level", l.level());
            m.put("message", l.message());
            return m;
        }).toList();
    }

    private List<Map<String, Object>> valueSetMaps(List<MeasureService.ValueSetRef> valueSets) {
        if (valueSets == null) return List.of();
        return valueSets.stream().map(vs -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", vs.id() == null ? null : vs.id().toString());
            m.put("oid", vs.oid());
            m.put("name", vs.name());
            m.put("version", vs.version());
            m.put("codeCount", vs.codeCount());
            m.put("resolvabilityStatus", vs.resolvabilityStatus());
            return m;
        }).toList();
    }

    private List<Map<String, Object>> testFixtureMaps(List<MeasureService.TestFixture> fixtures) {
        if (fixtures == null) return List.of();
        return fixtures.stream().map(f -> safeConvert(f)).toList();
    }

    private List<Map<String, Object>> filterApprovalHistory(List<Map<String, Object>> events) {
        return events.stream()
                .filter(e -> {
                    Object et = e.get("eventType");
                    if (et == null) return false;
                    String s = et.toString();
                    return s.equals("MEASURE_APPROVED") || s.equals("MEASURE_VERSION_STATUS_CHANGED") || s.equals("MEASURE_DEPRECATED");
                })
                .toList();
    }

    private List<Map<String, Object>> queryOutreachRecords(UUID caseId) {
        return jdbcTemplate.query(
                "SELECT id, type, status, template_name, auto_triggered, created_at FROM outreach_records WHERE case_id = ? ORDER BY created_at ASC",
                (rs, rowNum) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getObject("id") == null ? null : rs.getObject("id").toString());
                    m.put("type", rs.getString("type"));
                    m.put("status", rs.getString("status"));
                    m.put("templateName", rs.getString("template_name"));
                    m.put("autoTriggered", rs.getBoolean("auto_triggered"));
                    m.put("createdAt", rs.getTimestamp("created_at") == null ? null : rs.getTimestamp("created_at").toInstant().toString());
                    return m;
                },
                caseId
        );
    }

    private List<Map<String, Object>> queryAuditEventsByRun(UUID runId) {
        return jdbcTemplate.query(
                "SELECT event_type, actor, occurred_at, payload_json FROM audit_events WHERE ref_run_id = ? ORDER BY occurred_at ASC, id ASC",
                (rs, rowNum) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("eventType", rs.getString("event_type"));
                    m.put("actor", rs.getString("actor"));
                    m.put("occurredAt", rs.getTimestamp("occurred_at") == null ? null : rs.getTimestamp("occurred_at").toInstant().toString());
                    m.put("payload", parseJsonOrEmpty(rs.getString("payload_json")));
                    return m;
                },
                runId
        );
    }

    private List<Map<String, Object>> queryAuditEventsByMeasureVersion(UUID measureVersionId) {
        return jdbcTemplate.query(
                "SELECT event_type, actor, occurred_at, payload_json FROM audit_events WHERE ref_measure_version_id = ? ORDER BY occurred_at ASC, id ASC",
                (rs, rowNum) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("eventType", rs.getString("event_type"));
                    m.put("actor", rs.getString("actor"));
                    m.put("occurredAt", rs.getTimestamp("occurred_at") == null ? null : rs.getTimestamp("occurred_at").toInstant().toString());
                    m.put("payload", parseJsonOrEmpty(rs.getString("payload_json")));
                    return m;
                },
                measureVersionId
        );
    }

    private UUID lookupMeasureIdByVersion(UUID measureVersionId) {
        try {
            return jdbcTemplate.queryForObject(
                    "SELECT measure_id FROM measure_versions WHERE id = ?",
                    UUID.class,
                    measureVersionId
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure version not found: " + measureVersionId);
        }
    }

    private MeasureTraceabilityService.TraceabilityResponse tryGetTraceability(UUID measureId) {
        try {
            return traceabilityService.generate(measureId);
        } catch (Exception ignored) {
            return null;
        }
    }

    private DataReadinessService.DataReadinessResponse tryGetDataReadiness(UUID measureId) {
        try {
            return dataReadinessService.computeReadiness(measureId);
        } catch (Exception ignored) {
            return null;
        }
    }

    private ValueSetGovernanceService.ResolveCheckResult tryGetVsGovernance(UUID measureId) {
        try {
            return valueSetGovernanceService.resolveCheck(measureId);
        } catch (Exception ignored) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseJsonOrEmpty(String json) {
        if (json == null || json.isBlank()) return Map.of();
        try {
            Object parsed = objectMapper.readValue(json, Object.class);
            if (parsed instanceof Map<?, ?> m) {
                return (Map<String, Object>) m;
            }
            return Map.of("value", parsed);
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> safeConvert(Object obj) {
        try {
            String json = objectMapper.writeValueAsString(obj);
            return objectMapper.readValue(json, Map.class);
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    private byte[] serialize(Map<String, Object> packet) {
        try {
            return objectMapper.writeValueAsBytes(packet);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialize packet", ex);
        }
    }

    private String toJsonb(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialize JSON", ex);
        }
    }

    private String computeHash(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(bytes);
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException ex) {
            return "unavailable";
        }
    }

    private String renderHtml(Map<String, Object> packet) {
        String packetType = String.valueOf(packet.getOrDefault("packetType", ""));
        String generatedAt = String.valueOf(packet.getOrDefault("generatedAt", ""));
        String generatedBy = String.valueOf(packet.getOrDefault("generatedBy", ""));

        StringBuilder html = new StringBuilder();
        html.append("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\">");
        html.append("<title>WorkWell Audit Packet — ").append(esc(packetType)).append("</title>");
        html.append("<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#111;}");
        html.append("h1{font-size:1.5rem;border-bottom:2px solid #333;padding-bottom:8px;}");
        html.append("h2{font-size:1.1rem;margin-top:24px;color:#444;border-bottom:1px solid #ddd;padding-bottom:4px;}");
        html.append("table{border-collapse:collapse;width:100%;font-size:0.9rem;margin-top:8px;}");
        html.append("th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;}th{background:#f5f5f5;}");
        html.append(".meta{color:#666;font-size:0.85rem;} .disclaimer{background:#fffbe6;border:1px solid #ffe082;padding:8px 12px;margin:4px 0;border-radius:4px;font-size:0.85rem;}");
        html.append("pre{background:#f9f9f9;border:1px solid #ddd;padding:12px;overflow-x:auto;font-size:0.8rem;white-space:pre-wrap;word-break:break-all;}");
        html.append("</style></head><body>");

        html.append("<h1>WorkWell Audit Packet: ").append(esc(packetType)).append("</h1>");
        html.append("<p class=\"meta\">Generated: ").append(esc(generatedAt)).append(" &nbsp;|&nbsp; By: ").append(esc(generatedBy)).append("</p>");

        appendSection(html, "Packet Contents", packet, List.of("packetType", "generatedAt", "generatedBy", "disclaimers"));

        @SuppressWarnings("unchecked")
        List<String> disclaimers = (List<String>) packet.getOrDefault("disclaimers", List.of());
        if (!disclaimers.isEmpty()) {
            html.append("<h2>Disclaimers</h2>");
            for (String d : disclaimers) {
                html.append("<div class=\"disclaimer\">").append(esc(d)).append("</div>");
            }
        }

        html.append("<h2>Full Packet (JSON)</h2><pre>").append(esc(prettyJson(packet))).append("</pre>");
        html.append("</body></html>");
        return html.toString();
    }

    private void appendSection(StringBuilder html, String title, Map<String, Object> data, List<String> excludeKeys) {
        html.append("<h2>").append(esc(title)).append("</h2>");
        html.append("<table><tr><th>Field</th><th>Value</th></tr>");
        for (Map.Entry<String, Object> entry : data.entrySet()) {
            if (excludeKeys.contains(entry.getKey())) continue;
            html.append("<tr><td>").append(esc(entry.getKey())).append("</td><td>");
            Object val = entry.getValue();
            if (val == null) {
                html.append("<em>null</em>");
            } else if (val instanceof Map || val instanceof List) {
                html.append("<code>").append(esc(prettyJson(val))).append("</code>");
            } else {
                html.append(esc(String.valueOf(val)));
            }
            html.append("</td></tr>");
        }
        html.append("</table>");
    }

    private String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private String prettyJson(Object obj) {
        try {
            return objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(obj);
        } catch (JsonProcessingException ex) {
            return String.valueOf(obj);
        }
    }

    public record PacketResult(
            byte[] content,
            String contentType,
            String filename
    ) {}
}
