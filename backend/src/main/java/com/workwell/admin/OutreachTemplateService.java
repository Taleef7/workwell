package com.workwell.admin;

import java.time.Instant;
import java.util.List;
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
}
