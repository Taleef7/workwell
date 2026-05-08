package com.workwell.admin;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class WaiverService {
    private final JdbcTemplate jdbcTemplate;

    public WaiverService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<WaiverRecord> listWaivers(
            UUID measureId,
            String site,
            Instant expiresAfter,
            Instant expiresBefore,
            Boolean active
    ) {
        StringBuilder sql = new StringBuilder("""
                SELECT w.id AS waiver_id,
                       e.external_id AS employee_external_id,
                       e.name AS employee_name,
                       e.site AS employee_site,
                       m.id AS measure_id,
                       m.name AS measure_name,
                       mv.id AS measure_version_id,
                       mv.version AS measure_version,
                       w.exclusion_reason,
                       w.granted_by,
                       w.granted_at,
                       w.expires_at,
                       w.notes,
                       w.active,
                       CASE
                           WHEN w.active AND w.expires_at IS NOT NULL AND w.expires_at < NOW() THEN TRUE
                           ELSE FALSE
                       END AS expired
                FROM waivers w
                JOIN employees e ON w.employee_id = e.id
                JOIN measures m ON w.measure_id = m.id
                JOIN measure_versions mv ON w.measure_version_id = mv.id
                WHERE 1=1
                """);
        List<Object> args = new ArrayList<>();
        if (measureId != null) {
            sql.append(" AND m.id = ?");
            args.add(measureId);
        }
        if (site != null && !site.isBlank()) {
            sql.append(" AND LOWER(COALESCE(e.site, '')) = LOWER(?)");
            args.add(site);
        }
        if (expiresAfter != null) {
            sql.append(" AND w.expires_at >= ?");
            args.add(Timestamp.from(expiresAfter));
        }
        if (expiresBefore != null) {
            sql.append(" AND w.expires_at <= ?");
            args.add(Timestamp.from(expiresBefore));
        }
        if (active != null) {
            sql.append(" AND w.active = ?");
            args.add(active);
        }
        sql.append(" ORDER BY w.active DESC, w.expires_at ASC NULLS LAST, w.granted_at DESC");

        return jdbcTemplate.query(sql.toString(), (rs, rowNum) -> new WaiverRecord(
                (UUID) rs.getObject("waiver_id"),
                rs.getString("employee_external_id"),
                rs.getString("employee_name"),
                rs.getString("employee_site"),
                (UUID) rs.getObject("measure_id"),
                rs.getString("measure_name"),
                (UUID) rs.getObject("measure_version_id"),
                rs.getString("measure_version"),
                rs.getString("exclusion_reason"),
                rs.getString("granted_by"),
                toInstant(rs.getObject("granted_at")),
                toInstant(rs.getObject("expires_at")),
                rs.getString("notes"),
                rs.getBoolean("active"),
                rs.getBoolean("expired")
        ), args.toArray());
    }

    public WaiverRecord grantWaiver(
            String employeeExternalId,
            UUID measureId,
            String exclusionReason,
            String grantedBy,
            Instant expiresAt,
            String notes,
            Boolean active
    ) {
        if (employeeExternalId == null || employeeExternalId.isBlank()) {
            throw new IllegalArgumentException("employeeExternalId is required");
        }
        if (measureId == null) {
            throw new IllegalArgumentException("measureId is required");
        }
        if (exclusionReason == null || exclusionReason.isBlank()) {
            throw new IllegalArgumentException("exclusionReason is required");
        }

        UUID employeeId = resolveEmployeeId(employeeExternalId.trim());
        UUID measureVersionId = resolveLatestMeasureVersionId(measureId);
        String normalizedGrantedBy = grantedBy == null || grantedBy.isBlank() ? "system" : grantedBy.trim();
        UUID waiverId = UUID.randomUUID();

        jdbcTemplate.update(
                """
                        INSERT INTO waivers (
                            id, employee_id, measure_id, measure_version_id, exclusion_reason, granted_by, granted_at, expires_at, notes, active
                        ) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
                        """,
                waiverId,
                employeeId,
                measureId,
                measureVersionId,
                exclusionReason.trim(),
                normalizedGrantedBy,
                expiresAt == null ? null : Timestamp.from(expiresAt),
                notes == null || notes.isBlank() ? null : notes.trim(),
                active == null || active
        );

        return findWaiverById(waiverId)
                .orElseThrow(() -> new IllegalStateException("Unable to load waiver after insert"));
    }

    public Optional<WaiverRecord> ensureExclusionWaiver(
            UUID employeeId,
            UUID measureVersionId,
            String exclusionReason,
            String grantedBy,
            String notes
    ) {
        Optional<WaiverRecord> existing = findCurrentWaiver(employeeId, measureVersionId);
        if (existing.isPresent() && existing.get().active()) {
            return existing;
        }

        UUID measureId = resolveMeasureId(measureVersionId);
        UUID waiverId = UUID.randomUUID();
        jdbcTemplate.update(
                """
                        INSERT INTO waivers (
                            id, employee_id, measure_id, measure_version_id, exclusion_reason, granted_by, granted_at, expires_at, notes, active
                        ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NULL, ?, TRUE)
                        """,
                waiverId,
                employeeId,
                measureId,
                measureVersionId,
                exclusionReason == null || exclusionReason.isBlank()
                        ? "Excluded outcome recorded from evaluation."
                        : exclusionReason.trim(),
                grantedBy == null || grantedBy.isBlank() ? "system" : grantedBy.trim(),
                notes == null || notes.isBlank() ? "Auto-linked from excluded evaluation." : notes.trim()
        );
        return findWaiverById(waiverId);
    }

    public Optional<WaiverRecord> findCurrentWaiver(UUID employeeId, UUID measureVersionId) {
        String sql = """
                SELECT w.id AS waiver_id,
                       e.external_id AS employee_external_id,
                       e.name AS employee_name,
                       e.site AS employee_site,
                       m.id AS measure_id,
                       m.name AS measure_name,
                       mv.id AS measure_version_id,
                       mv.version AS measure_version,
                       w.exclusion_reason,
                       w.granted_by,
                       w.granted_at,
                       w.expires_at,
                       w.notes,
                       w.active,
                       CASE
                           WHEN w.active AND w.expires_at IS NOT NULL AND w.expires_at < NOW() THEN TRUE
                           ELSE FALSE
                       END AS expired
                FROM waivers w
                JOIN employees e ON w.employee_id = e.id
                JOIN measures m ON w.measure_id = m.id
                JOIN measure_versions mv ON w.measure_version_id = mv.id
                WHERE w.employee_id = ? AND w.measure_version_id = ?
                ORDER BY w.active DESC, w.granted_at DESC, w.id DESC
                LIMIT 1
                """;

        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(
                    sql,
                    (rs, rowNum) -> new WaiverRecord(
                            (UUID) rs.getObject("waiver_id"),
                            rs.getString("employee_external_id"),
                            rs.getString("employee_name"),
                            rs.getString("employee_site"),
                            (UUID) rs.getObject("measure_id"),
                            rs.getString("measure_name"),
                            (UUID) rs.getObject("measure_version_id"),
                            rs.getString("measure_version"),
                            rs.getString("exclusion_reason"),
                            rs.getString("granted_by"),
                            toInstant(rs.getObject("granted_at")),
                            toInstant(rs.getObject("expires_at")),
                            rs.getString("notes"),
                            rs.getBoolean("active"),
                            rs.getBoolean("expired")
                    ),
                    employeeId,
                    measureVersionId
            ));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    public Optional<WaiverRecord> findWaiverById(UUID waiverId) {
        String sql = """
                SELECT w.id AS waiver_id,
                       e.external_id AS employee_external_id,
                       e.name AS employee_name,
                       e.site AS employee_site,
                       m.id AS measure_id,
                       m.name AS measure_name,
                       mv.id AS measure_version_id,
                       mv.version AS measure_version,
                       w.exclusion_reason,
                       w.granted_by,
                       w.granted_at,
                       w.expires_at,
                       w.notes,
                       w.active,
                       CASE
                           WHEN w.active AND w.expires_at IS NOT NULL AND w.expires_at < NOW() THEN TRUE
                           ELSE FALSE
                       END AS expired
                FROM waivers w
                JOIN employees e ON w.employee_id = e.id
                JOIN measures m ON w.measure_id = m.id
                JOIN measure_versions mv ON w.measure_version_id = mv.id
                WHERE w.id = ?
                """;

        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(
                    sql,
                    (rs, rowNum) -> new WaiverRecord(
                            (UUID) rs.getObject("waiver_id"),
                            rs.getString("employee_external_id"),
                            rs.getString("employee_name"),
                            rs.getString("employee_site"),
                            (UUID) rs.getObject("measure_id"),
                            rs.getString("measure_name"),
                            (UUID) rs.getObject("measure_version_id"),
                            rs.getString("measure_version"),
                            rs.getString("exclusion_reason"),
                            rs.getString("granted_by"),
                            toInstant(rs.getObject("granted_at")),
                            toInstant(rs.getObject("expires_at")),
                            rs.getString("notes"),
                            rs.getBoolean("active"),
                            rs.getBoolean("expired")
                    ),
                    waiverId
            ));
        } catch (EmptyResultDataAccessException ex) {
            return Optional.empty();
        }
    }

    private UUID resolveEmployeeId(String employeeExternalId) {
        try {
            return jdbcTemplate.queryForObject(
                    "SELECT id FROM employees WHERE external_id = ?",
                    UUID.class,
                    employeeExternalId
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Employee not found: " + employeeExternalId);
        }
    }

    private UUID resolveMeasureId(UUID measureVersionId) {
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

    private UUID resolveLatestMeasureVersionId(UUID measureId) {
        try {
            return jdbcTemplate.queryForObject(
                    """
                            SELECT id
                            FROM measure_versions
                            WHERE measure_id = ?
                            ORDER BY (CASE WHEN status = 'Active' THEN 0 ELSE 1 END), created_at DESC
                            LIMIT 1
                            """,
                    UUID.class,
                    measureId
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure not found: " + measureId);
        }
    }

    private Instant toInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        throw new IllegalStateException("Unexpected timestamp value: " + value.getClass());
    }

    public record WaiverRecord(
            UUID waiverId,
            String employeeExternalId,
            String employeeName,
            String site,
            UUID measureId,
            String measureName,
            UUID measureVersionId,
            String measureVersion,
            String exclusionReason,
            String grantedBy,
            Instant grantedAt,
            Instant expiresAt,
            String notes,
            boolean active,
            boolean expired
    ) {
    }
}
