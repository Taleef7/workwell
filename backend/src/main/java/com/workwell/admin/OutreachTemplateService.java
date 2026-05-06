package com.workwell.admin;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class OutreachTemplateService {
    private final JdbcTemplate jdbcTemplate;

    public OutreachTemplateService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<OutreachTemplate> listTemplates() {
        try {
            return jdbcTemplate.query(
                    """
                            SELECT id, name, subject, body_text, measure_id, created_at
                            FROM outreach_templates
                            ORDER BY created_at DESC, name ASC
                            """,
                    (rs, rowNum) -> new OutreachTemplate(
                            (UUID) rs.getObject("id"),
                            rs.getString("name"),
                            rs.getString("subject"),
                            rs.getString("body_text"),
                            (UUID) rs.getObject("measure_id"),
                            rs.getTimestamp("created_at") == null ? null : rs.getTimestamp("created_at").toInstant()
                    )
            );
        } catch (DataAccessException ex) {
            return fallbackTemplates();
        }
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

    private List<OutreachTemplate> fallbackTemplates() {
        Instant now = Instant.now();
        return List.of(
                new OutreachTemplate(
                        UUID.fromString("11111111-0000-0000-0000-000000000001"),
                        "Audiogram Overdue Reminder",
                        "Action Needed: Overdue Audiogram Follow-up",
                        "Your annual audiogram is overdue. Please coordinate with occupational health for immediate scheduling.",
                        null,
                        now
                ),
                new OutreachTemplate(
                        UUID.fromString("11111111-0000-0000-0000-000000000002"),
                        "TB Due Soon Reminder",
                        "Upcoming TB Screening Due Date",
                        "Your TB surveillance screening is due soon. Please book your screening within the compliance window.",
                        null,
                        now
                ),
                new OutreachTemplate(
                        UUID.fromString("11111111-0000-0000-0000-000000000003"),
                        "Flu Vaccine Follow-up",
                        "Seasonal Flu Vaccine Compliance Reminder",
                        "Please complete this season's flu vaccine documentation to maintain program compliance.",
                        null,
                        now
                )
        );
    }

    public record OutreachTemplate(
            UUID id,
            String name,
            String subject,
            String bodyText,
            UUID measureId,
            Instant createdAt
    ) {
    }
}
