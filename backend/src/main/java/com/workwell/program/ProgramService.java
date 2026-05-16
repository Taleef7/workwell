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

    public List<String> listSites() {
        return jdbcTemplate.query(
                """
                        SELECT DISTINCT site
                        FROM employees
                        WHERE site IS NOT NULL AND site <> ''
                        ORDER BY site ASC
                        """,
                (rs, rowNum) -> rs.getString("site")
        );
    }

    public List<ProgramSummary> listPrograms(String site, Instant from, Instant to) {
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
                ), filtered_outcomes AS (
                    SELECT o.*
                    FROM outcomes o
                    JOIN employees e ON e.id = o.employee_id
                    JOIN runs r ON r.id = o.run_id
                    WHERE (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
                      AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at >= CAST(? AS TIMESTAMPTZ))
                      AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at <= CAST(? AS TIMESTAMPTZ))
                ), latest_run AS (
                    SELECT fo.measure_version_id,
                           fo.run_id,
                           r.started_at,
                           ROW_NUMBER() OVER (PARTITION BY fo.measure_version_id ORDER BY r.started_at DESC) AS rn
                    FROM filtered_outcomes fo
                    JOIN runs r ON r.id = fo.run_id
                ), outcome_counts AS (
                    SELECT fo.measure_version_id,
                           fo.run_id,
                           COUNT(*) AS total_evaluated,
                           COUNT(*) FILTER (WHERE fo.status = 'COMPLIANT') AS compliant,
                           COUNT(*) FILTER (WHERE fo.status = 'DUE_SOON') AS due_soon,
                           COUNT(*) FILTER (WHERE fo.status = 'OVERDUE') AS overdue,
                           COUNT(*) FILTER (WHERE fo.status = 'MISSING_DATA') AS missing_data,
                           COUNT(*) FILTER (WHERE fo.status = 'EXCLUDED') AS excluded
                    FROM filtered_outcomes fo
                    GROUP BY fo.measure_version_id, fo.run_id
                ), open_cases AS (
                    SELECT c.measure_version_id,
                           COUNT(*) FILTER (WHERE c.status = 'OPEN') AS open_case_count
                    FROM cases c
                    JOIN employees e ON e.id = c.employee_id
                    WHERE (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
                      AND (CAST(? AS TIMESTAMPTZ) IS NULL OR c.created_at >= CAST(? AS TIMESTAMPTZ))
                      AND (CAST(? AS TIMESTAMPTZ) IS NULL OR c.created_at <= CAST(? AS TIMESTAMPTZ))
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
        ),
                site, site,
                from == null ? null : Timestamp.from(from), from == null ? null : Timestamp.from(from),
                to == null ? null : Timestamp.from(to), to == null ? null : Timestamp.from(to),
                site, site,
                from == null ? null : Timestamp.from(from), from == null ? null : Timestamp.from(from),
                to == null ? null : Timestamp.from(to), to == null ? null : Timestamp.from(to)
        );
    }

    public List<ProgramTrendPoint> trend(UUID measureId, String site, Instant from, Instant to) {
        // Union of outcome-level data (real runs with employee rows) and run-level aggregate
        // data (MEASURE-scoped seeded/historical runs that have no outcome rows). Deduplicates
        // by excluding run IDs already covered by the outcome-based branch.
        String sql = """
                WITH active_measure_version AS (
                    SELECT mv.id
                    FROM measure_versions mv
                    WHERE mv.measure_id = ?
                    ORDER BY mv.created_at DESC
                    LIMIT 1
                ),
                outcome_based AS (
                    SELECT o.run_id,
                           r.started_at,
                           COUNT(*)                                        AS total_evaluated,
                           COUNT(*) FILTER (WHERE o.status = 'COMPLIANT') AS compliant
                    FROM outcomes o
                    JOIN runs r ON r.id = o.run_id
                    JOIN employees e ON e.id = o.employee_id
                    JOIN active_measure_version amv ON amv.id = o.measure_version_id
                    WHERE (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
                      AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at >= CAST(? AS TIMESTAMPTZ))
                      AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at <= CAST(? AS TIMESTAMPTZ))
                    GROUP BY o.run_id, r.started_at
                ),
                run_based AS (
                    -- Excluded when site filter is active: aggregate runs carry no per-site
                    -- breakdown, so they cannot be filtered correctly and must not pollute
                    -- site-specific trend charts.
                    SELECT r.id    AS run_id,
                           r.started_at,
                           COALESCE(r.total_evaluated, 0) AS total_evaluated,
                           COALESCE(r.compliant, 0)        AS compliant
                    FROM runs r
                    JOIN active_measure_version amv ON amv.id = r.scope_id
                    WHERE CAST(? AS TEXT) IS NULL
                      AND r.scope_type = 'MEASURE'
                      AND r.status    = 'COMPLETED'
                      AND r.dry_run   = false
                      AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at >= CAST(? AS TIMESTAMPTZ))
                      AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at <= CAST(? AS TIMESTAMPTZ))
                      AND r.id NOT IN (SELECT run_id FROM outcome_based)
                )
                SELECT run_id, started_at, total_evaluated, compliant
                FROM outcome_based
                UNION ALL
                SELECT run_id, started_at, total_evaluated, compliant
                FROM run_based
                ORDER BY started_at DESC
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
        }, measureId, site, site,
                from == null ? null : Timestamp.from(from), from == null ? null : Timestamp.from(from),
                to == null ? null : Timestamp.from(to), to == null ? null : Timestamp.from(to),
                site,  // run_based: skip branch when site filter is active
                from == null ? null : Timestamp.from(from), from == null ? null : Timestamp.from(from),
                to == null ? null : Timestamp.from(to), to == null ? null : Timestamp.from(to));
    }

    public TopDrivers topDrivers(UUID measureId, String site, Instant from, Instant to) {
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
                JOIN employees e ON e.id = o.employee_id
                JOIN active_measure_version amv ON amv.id = o.measure_version_id
                WHERE (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
                  AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at >= CAST(? AS TIMESTAMPTZ))
                  AND (CAST(? AS TIMESTAMPTZ) IS NULL OR r.started_at <= CAST(? AS TIMESTAMPTZ))
                GROUP BY o.run_id, r.started_at
                ORDER BY r.started_at DESC
                LIMIT 1
                """,
                rs -> rs.next() ? (UUID) rs.getObject("run_id") : null,
                measureId,
                site, site,
                from == null ? null : Timestamp.from(from), from == null ? null : Timestamp.from(from),
                to == null ? null : Timestamp.from(to), to == null ? null : Timestamp.from(to)
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
                  AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
                GROUP BY e.site
                ORDER BY overdue_count DESC, e.site ASC
                LIMIT 5
                """,
                (rs, rowNum) -> new DriverSite(
                        rs.getString("site"),
                        rs.getLong("overdue_count"),
                        "High overdue concentration"
                ),
                latestRunId, site, site
        );

        List<DriverRole> byRole = jdbcTemplate.query(
                """
                SELECT e.role, COUNT(*) AS overdue_count
                FROM outcomes o
                JOIN employees e ON e.id = o.employee_id
                WHERE o.run_id = ? AND o.status = 'OVERDUE'
                  AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
                GROUP BY e.role
                ORDER BY overdue_count DESC, e.role ASC
                LIMIT 5
                """,
                (rs, rowNum) -> new DriverRole(
                        rs.getString("role"),
                        rs.getLong("overdue_count")
                ),
                latestRunId, site, site
        );

        long totalFlagged = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM outcomes o JOIN employees e ON e.id = o.employee_id WHERE o.run_id = ? AND o.status IN ('OVERDUE', 'MISSING_DATA', 'DUE_SOON') AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))",
                Long.class,
                latestRunId, site, site
        );

        List<DriverOutcomeReason> byOutcomeReason = jdbcTemplate.query(
                """
                SELECT o.status AS reason, COUNT(*) AS cnt
                FROM outcomes o
                JOIN employees e ON e.id = o.employee_id
                WHERE o.run_id = ? AND o.status IN ('OVERDUE', 'MISSING_DATA', 'DUE_SOON')
                  AND (CAST(? AS TEXT) IS NULL OR LOWER(COALESCE(e.site, '')) = LOWER(CAST(? AS TEXT)))
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
                latestRunId, site, site
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
