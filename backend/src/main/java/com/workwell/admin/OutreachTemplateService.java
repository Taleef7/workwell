package com.workwell.admin;

import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class OutreachTemplateService {
    private final JdbcTemplate jdbcTemplate;

    public OutreachTemplateService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<OutreachTemplate> listTemplates() {
        return jdbcTemplate.query(
                """
                        SELECT id, name, subject, body_text, type, created_by, created_at, updated_at, active
                        FROM outreach_templates
                        WHERE active = TRUE
                        ORDER BY created_at DESC, name ASC
                        """,
                (rs, rowNum) -> new OutreachTemplate(
                        (UUID) rs.getObject("id"),
                        rs.getString("name"),
                        rs.getString("subject"),
                        rs.getString("body_text"),
                        rs.getString("type"),
                        rs.getString("created_by"),
                        rs.getTimestamp("created_at") == null ? null : rs.getTimestamp("created_at").toInstant(),
                        rs.getTimestamp("updated_at") == null ? null : rs.getTimestamp("updated_at").toInstant(),
                        rs.getBoolean("active")
                )
        );
    }

    public OutreachTemplate resolveByIdOrDefault(UUID templateId) {
        List<OutreachTemplate> templates = listTemplates();
        if (templates.isEmpty()) {
            return null;
        }
        if (templateId == null) {
            return templates.get(0);
        }
        return templates.stream()
                .filter(t -> templateId.equals(t.id()))
                .findFirst()
                .orElse(templates.get(0));
    }

    /**
     * The canonical template NAME for a (outcome, measure) (#150 M1). Shared by the auto-notification
     * path and the manual preview/send default so both pick the SAME template:
     *   MISSING_DATA → the missing-data template; DUE_SOON → the measure's reminder (hearing/TB, else
     *   general); OVERDUE/other → the General Compliance Reminder — a generic, measure-AGNOSTIC body,
     *   not a measure-specific one (which would render the wrong measure's copy for, e.g., a TB case).
     */
    public String templateNameForOutcome(String outcomeStatus, String measureName) {
        String normalizedMeasure = measureName == null ? "" : measureName.toLowerCase(Locale.ROOT);
        return switch (outcomeStatus == null ? "" : outcomeStatus.trim().toUpperCase(Locale.ROOT)) {
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
            default -> "General Compliance Reminder"; // OVERDUE + everything else → generic
        };
    }

    /**
     * Outcome-aware default selection (#150 M1): an explicit {@code templateId} wins; otherwise pick the
     * template matching the case's outcome bucket + measure ({@link #templateNameForOutcome}) — the same
     * mapping the auto-notification path uses, so the operator's manual default agrees with what was
     * auto-queued instead of always sending the newest/first template.
     */
    public OutreachTemplate resolveForOutcome(UUID templateId, String outcomeStatus, String measureName) {
        if (templateId != null) {
            return resolveByIdOrDefault(templateId);
        }
        return resolveByNameOrDefault(templateNameForOutcome(outcomeStatus, measureName));
    }

    public OutreachTemplate resolveByNameOrDefault(String templateName) {
        List<OutreachTemplate> templates = listTemplates();
        if (templates.isEmpty()) {
            return null;
        }
        if (templateName == null || templateName.isBlank()) {
            return templates.get(0);
        }
        return templates.stream()
                .filter(t -> templateName.equalsIgnoreCase(t.name()))
                .findFirst()
                .orElse(templates.get(0));
    }

    public OutreachTemplate createTemplate(String name, String subject, String bodyText, String type, String actor) {
        UUID id = UUID.randomUUID();
        String normalizedType = normalizeType(type);
        jdbcTemplate.update(
                """
                        INSERT INTO outreach_templates (id, name, subject, body_text, type, created_by, created_at, updated_at, active)
                        VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), TRUE)
                        """,
                id,
                name.trim(),
                subject.trim(),
                bodyText.trim(),
                normalizedType,
                actor
        );
        return jdbcTemplate.queryForObject(
                """
                        SELECT id, name, subject, body_text, type, created_by, created_at, updated_at, active
                        FROM outreach_templates
                        WHERE id = ?
                        """,
                (rs, rowNum) -> new OutreachTemplate(
                        (UUID) rs.getObject("id"),
                        rs.getString("name"),
                        rs.getString("subject"),
                        rs.getString("body_text"),
                        rs.getString("type"),
                        rs.getString("created_by"),
                        rs.getTimestamp("created_at").toInstant(),
                        rs.getTimestamp("updated_at").toInstant(),
                        rs.getBoolean("active")
                ),
                id
        );
    }

    public OutreachTemplate updateTemplate(UUID id, String name, String subject, String bodyText, String type, boolean active) {
        String normalizedType = normalizeType(type);
        int updated = jdbcTemplate.update(
                """
                        UPDATE outreach_templates
                        SET name = ?,
                            subject = ?,
                            body_text = ?,
                            type = ?,
                            active = ?,
                            updated_at = NOW()
                        WHERE id = ?
                        """,
                name.trim(),
                subject.trim(),
                bodyText.trim(),
                normalizedType,
                active,
                id
        );
        if (updated == 0) {
            throw new IllegalArgumentException("Outreach template not found: " + id);
        }
        return jdbcTemplate.queryForObject(
                """
                        SELECT id, name, subject, body_text, type, created_by, created_at, updated_at, active
                        FROM outreach_templates
                        WHERE id = ?
                        """,
                (rs, rowNum) -> new OutreachTemplate(
                        (UUID) rs.getObject("id"),
                        rs.getString("name"),
                        rs.getString("subject"),
                        rs.getString("body_text"),
                        rs.getString("type"),
                        rs.getString("created_by"),
                        rs.getTimestamp("created_at").toInstant(),
                        rs.getTimestamp("updated_at").toInstant(),
                        rs.getBoolean("active")
                ),
                id
        );
    }

    public TemplatePreview previewTemplate(UUID id) {
        OutreachTemplate template;
        try {
            template = jdbcTemplate.queryForObject(
                    """
                            SELECT id, name, subject, body_text, type, created_by, created_at, updated_at, active
                            FROM outreach_templates
                            WHERE id = ?
                            """,
                    (rs, rowNum) -> new OutreachTemplate(
                            (UUID) rs.getObject("id"),
                            rs.getString("name"),
                            rs.getString("subject"),
                            rs.getString("body_text"),
                            rs.getString("type"),
                            rs.getString("created_by"),
                            rs.getTimestamp("created_at") == null ? null : rs.getTimestamp("created_at").toInstant(),
                            rs.getTimestamp("updated_at") == null ? null : rs.getTimestamp("updated_at").toInstant(),
                            rs.getBoolean("active")
                    ),
                    id
            );
        } catch (org.springframework.dao.EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Outreach template not found: " + id);
        }
        return new TemplatePreview(
                template.id(),
                template.name(),
                render(template.subject()),
                render(template.bodyText())
        );
    }

    private String render(String raw) {
        if (raw == null) {
            return "";
        }
        // Sample placeholder values for the Admin preview. Plain-text string replacement is
        // sufficient for the fixed variable set used by the demo templates.
        return raw
                .replace("{employee_name}", "Jane Smith")
                .replace("{measure_name}", "Annual Audiogram")
                .replace("{due_date}", "2026-05-30")
                .replace("{assignee_name}", "Sarah Mitchell");
    }

    private String normalizeType(String type) {
        if (type == null || type.isBlank()) {
            return "OUTREACH";
        }
        String normalized = type.trim().toUpperCase();
        return switch (normalized) {
            case "OUTREACH", "APPOINTMENT_REMINDER", "ESCALATION" -> normalized;
            default -> throw new IllegalArgumentException("Unsupported template type: " + type);
        };
    }

    public record OutreachTemplate(
            UUID id,
            String name,
            String subject,
            String bodyText,
            String type,
            String createdBy,
            Instant createdAt,
            Instant updatedAt,
            boolean active
    ) {
    }

    public record TemplatePreview(
            UUID id,
            String name,
            String subject,
            String bodyText
    ) {
    }
}
