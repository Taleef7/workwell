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
     * Outcome-aware default selection (#150 M1): when the operator hasn't picked a template, choose
     * the OUTREACH template whose name matches the case's outcome bucket (OVERDUE → "overdue",
     * MISSING_DATA → "missing", DUE_SOON → "reminder") so the message fits the situation, instead of
     * always sending the newest/first template. Falls back to the first OUTREACH template, then the
     * first template. An explicit {@code templateId} always wins (the operator's choice is respected).
     */
    public OutreachTemplate resolveForOutcome(UUID templateId, String outcomeStatus) {
        if (templateId != null) {
            return resolveByIdOrDefault(templateId);
        }
        List<OutreachTemplate> templates = listTemplates();
        if (templates.isEmpty()) {
            return null;
        }
        String keyword = switch (outcomeStatus == null ? "" : outcomeStatus.trim().toUpperCase(Locale.ROOT)) {
            case "MISSING_DATA" -> "missing";
            case "OVERDUE" -> "overdue";
            case "DUE_SOON" -> "reminder";
            default -> null;
        };
        if (keyword != null) {
            for (OutreachTemplate t : templates) {
                if (isOutreachType(t) && t.name() != null && t.name().toLowerCase(Locale.ROOT).contains(keyword)) {
                    return t;
                }
            }
        }
        for (OutreachTemplate t : templates) {
            if (isOutreachType(t)) {
                return t;
            }
        }
        return templates.get(0);
    }

    /** OUTREACH-type templates are the auto-selectable ones (APPOINTMENT_REMINDER/ESCALATION are not). */
    private static boolean isOutreachType(OutreachTemplate t) {
        return t.type() == null || "OUTREACH".equalsIgnoreCase(t.type());
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
