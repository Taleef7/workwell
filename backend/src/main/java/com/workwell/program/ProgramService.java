package com.workwell.program;

import com.workwell.measure.MeasureService;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class ProgramService {
    private final JdbcTemplate jdbcTemplate;
    private final MeasureService measureService;

    public ProgramService(JdbcTemplate jdbcTemplate, MeasureService measureService) {
        this.jdbcTemplate = jdbcTemplate;
        this.measureService = measureService;
    }

    public List<ProgramSummary> listPrograms() {
        measureService.listMeasures();
        String sql = """
                WITH active_versions AS (
                    SELECT m.id AS measure_id,
                           m.name AS measure_name,
                           m.policy_ref,
                           mv.id AS measure_version_id,
                           mv.version,
                           mv.status,
                           ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY mv.created_at DESC) AS rn
                    FROM measures m
                    JOIN measure_versions mv ON mv.measure_id = m.id
                    WHERE mv.status = 'Active'
                ), latest_run AS (
                    SELECT o.measure_version_id,
                           o.run_id,
                           r.started_at,
                           ROW_NUMBER() OVER (PARTITION BY o.measure_version_id ORDER BY r.started_at DESC) AS rn
                    FROM outcomes o
                    JOIN runs r ON r.id = o.run_id
                ), outcome_counts AS (
                    SELECT o.measure_version_id,
                           o.run_id,
                           COUNT(*) AS total_evaluated,
                           COUNT(*) FILTER (WHERE o.status = 'COMPLIANT') AS compliant,
                           COUNT(*) FILTER (WHERE o.status = 'DUE_SOON') AS due_soon,
                           COUNT(*) FILTER (WHERE o.status = 'OVERDUE') AS overdue,
                           COUNT(*) FILTER (WHERE o.status = 'MISSING_DATA') AS missing_data,
                           COUNT(*) FILTER (WHERE o.status = 'EXCLUDED') AS excluded
                    FROM outcomes o
                    GROUP BY o.measure_version_id, o.run_id
                ), open_cases AS (
                    SELECT c.measure_version_id,
                           COUNT(*) FILTER (WHERE c.status = 'OPEN') AS open_case_count
                    FROM cases c
                    GROUP BY c.measure_version_id
                )
                SELECT av.measure_id,
                       av.measure_name,
                       av.policy_ref,
                       av.version,
                       lr.run_id AS latest_run_id,
                       lr.started_at AS latest_run_at,
                       COALESCE(oc.total_evaluated, 0) AS total_evaluated,
                       COALESCE(oc.compliant, 0) AS compliant,
                       COALESCE(oc.due_soon, 0) AS due_soon,
                       COALESCE(oc.overdue, 0) AS overdue,
                       COALESCE(oc.missing_data, 0) AS missing_data,
                       COALESCE(oc.excluded, 0) AS excluded,
                       CASE WHEN COALESCE(oc.total_evaluated, 0) = 0 THEN 0
                            ELSE ROUND((oc.compliant::numeric / oc.total_evaluated::numeric) * 100, 1)
                       END AS compliance_rate,
                       COALESCE(ocases.open_case_count, 0) AS open_case_count
                FROM active_versions av
                LEFT JOIN latest_run lr ON lr.measure_version_id = av.measure_version_id AND lr.rn = 1
                LEFT JOIN outcome_counts oc ON oc.measure_version_id = av.measure_version_id AND oc.run_id = lr.run_id
                LEFT JOIN open_cases ocases ON ocases.measure_version_id = av.measure_version_id
                WHERE av.rn = 1
                ORDER BY av.measure_name ASC
                """;

        return jdbcTemplate.query(sql, (rs, rowNum) -> new ProgramSummary(
                (UUID) rs.getObject("measure_id"),
                rs.getString("measure_name"),
                rs.getString("policy_ref"),
                rs.getString("version"),
                rs.getObject("latest_run_id") == null ? null : (UUID) rs.getObject("latest_run_id"),
                toInstant(rs.getObject("latest_run_at")),
                rs.getLong("total_evaluated"),
                rs.getLong("compliant"),
                rs.getLong("due_soon"),
                rs.getLong("overdue"),
                rs.getLong("missing_data"),
                rs.getLong("excluded"),
                rs.getDouble("compliance_rate"),
                rs.getLong("open_case_count")
        ));
    }

    public List<ProgramTrendPoint> trend(UUID measureId) {
        String sql = """
                WITH active_measure_version AS (
                    SELECT mv.id
                    FROM measure_versions mv
                    WHERE mv.measure_id = ?
                    ORDER BY mv.created_at DESC
                    LIMIT 1
                )
                SELECT o.run_id,
                       r.started_at,
                       COUNT(*) AS total_evaluated,
                       COUNT(*) FILTER (WHERE o.status = 'COMPLIANT') AS compliant
                FROM outcomes o
                JOIN runs r ON r.id = o.run_id
                JOIN active_measure_version amv ON amv.id = o.measure_version_id
                GROUP BY o.run_id, r.started_at
                ORDER BY r.started_at DESC
                LIMIT 10
                """;

        return jdbcTemplate.query(sql, (rs, rowNum) -> {
            long totalEvaluated = rs.getLong("total_evaluated");
            long compliant = rs.getLong("compliant");
            double complianceRate = totalEvaluated == 0 ? 0d : Math.round((compliant * 1000.0 / totalEvaluated)) / 10.0;
            return new ProgramTrendPoint(
                    (UUID) rs.getObject("run_id"),
                    toInstant(rs.getObject("started_at")),
                    complianceRate,
                    totalEvaluated
            );
        }, measureId);
    }

    public TopDrivers topDrivers(UUID measureId) {
        UUID latestRunId = jdbcTemplate.query(
                """
                WITH active_measure_version AS (
                    SELECT mv.id
                    FROM measure_versions mv
                    WHERE mv.measure_id = ?
                    ORDER BY mv.created_at DESC
                    LIMIT 1
                )
                SELECT o.run_id
                FROM outcomes o
                JOIN runs r ON r.id = o.run_id
                JOIN active_measure_version amv ON amv.id = o.measure_version_id
                GROUP BY o.run_id, r.started_at
                ORDER BY r.started_at DESC
                LIMIT 1
                """,
                rs -> rs.next() ? (UUID) rs.getObject("run_id") : null,
                measureId
        );

        if (latestRunId == null) {
            return new TopDrivers(List.of(), List.of(), List.of());
        }

        List<DriverSite> bySite = jdbcTemplate.query(
                """
                SELECT e.site, COUNT(*) AS overdue_count
                FROM outcomes o
                JOIN employees e ON e.id = o.employee_id
                WHERE o.run_id = ? AND o.status = 'OVERDUE'
                GROUP BY e.site
                ORDER BY overdue_count DESC, e.site ASC
                LIMIT 5
                """,
                (rs, rowNum) -> new DriverSite(
                        rs.getString("site"),
                        rs.getLong("overdue_count"),
                        "High overdue concentration"
                ),
                latestRunId
        );

        List<DriverRole> byRole = jdbcTemplate.query(
                """
                SELECT e.role, COUNT(*) AS overdue_count
                FROM outcomes o
                JOIN employees e ON e.id = o.employee_id
                WHERE o.run_id = ? AND o.status = 'OVERDUE'
                GROUP BY e.role
                ORDER BY overdue_count DESC, e.role ASC
                LIMIT 5
                """,
                (rs, rowNum) -> new DriverRole(
                        rs.getString("role"),
                        rs.getLong("overdue_count")
                ),
                latestRunId
        );

        long totalFlagged = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM outcomes WHERE run_id = ? AND status IN ('OVERDUE', 'MISSING_DATA')",
                Long.class,
                latestRunId
        );

        List<DriverOutcomeReason> byOutcomeReason = jdbcTemplate.query(
                """
                SELECT o.status AS reason, COUNT(*) AS cnt
                FROM outcomes o
                WHERE o.run_id = ? AND o.status IN ('OVERDUE', 'MISSING_DATA')
                GROUP BY o.status
                ORDER BY cnt DESC
                """,
                (rs, rowNum) -> {
                    long count = rs.getLong("cnt");
                    double pct = totalFlagged == 0 ? 0d : Math.round((count * 1000.0 / totalFlagged)) / 10.0;
                    return new DriverOutcomeReason(
                            rs.getString("reason"),
                            count,
                            pct
                    );
                },
                latestRunId
        );

        return new TopDrivers(bySite, byRole, byOutcomeReason);
    }

    private Instant toInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Timestamp ts) {
            return ts.toInstant();
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        return null;
    }

    public record ProgramSummary(
            UUID measureId,
            String measureName,
            String policyRef,
            String version,
            UUID latestRunId,
            Instant latestRunAt,
            long totalEvaluated,
            long compliant,
            long dueSoon,
            long overdue,
            long missingData,
            long excluded,
            double complianceRate,
            long openCaseCount
    ) {
    }

    public record ProgramTrendPoint(
            UUID runId,
            Instant startedAt,
            double complianceRate,
            long totalEvaluated
    ) {
    }

    public record TopDrivers(
            List<DriverSite> bySite,
            List<DriverRole> byRole,
            List<DriverOutcomeReason> byOutcomeReason
    ) {
    }

    public record DriverSite(
            String site,
            long overdueCount,
            String note
    ) {
    }

    public record DriverRole(
            String role,
            long overdueCount
    ) {
    }

    public record DriverOutcomeReason(
            String reason,
            long count,
            double pct
    ) {
    }
}
