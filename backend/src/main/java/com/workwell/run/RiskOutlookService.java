package com.workwell.run;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class RiskOutlookService {
    private static final int DUE_SOON_BUFFER_DAYS = 30;

    private final JdbcTemplate jdbcTemplate;

    public RiskOutlookService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public RiskOutlookResult getOutlook(UUID measureId, int horizonDays) {
        if (measureId == null) {
            throw new IllegalArgumentException("measureId is required");
        }
        int safeHorizonDays = Math.max(1, Math.min(horizonDays, 180));
        MeasureContext context = loadMeasureContext(measureId);
        List<LatestOutcomeSnapshot> latestOutcomes = loadLatestOutcomeSnapshots(context.measureVersionId());

        Map<String, SiteAccumulator> siteAccumulators = new LinkedHashMap<>();
        List<UpcomingExpiration> upcomingExpirations = new ArrayList<>();
        LocalDate today = LocalDate.now();

        for (LatestOutcomeSnapshot snapshot : latestOutcomes) {
            SiteAccumulator site = siteAccumulators.computeIfAbsent(snapshot.site(), key -> new SiteAccumulator());
            site.total++;
            if ("COMPLIANT".equals(snapshot.status())) {
                site.compliant++;
            }

            if (isBecomingDueSoon(snapshot, today, safeHorizonDays)) {
                int dueSoonThresholdDays = Math.max(snapshot.complianceWindowDays() - DUE_SOON_BUFFER_DAYS, 0);
                long daysSinceLastExam = ChronoUnit.DAYS.between(snapshot.lastExamDate(), today);
                int daysUntilDueSoon = (int) Math.max(0, dueSoonThresholdDays - daysSinceLastExam);
                LocalDate predictedDueSoonDate = snapshot.lastExamDate().plusDays(dueSoonThresholdDays);
                site.upcomingExpirations++;
                upcomingExpirations.add(new UpcomingExpiration(
                        snapshot.externalId(),
                        snapshot.name(),
                        snapshot.site(),
                        context.measureName(),
                        snapshot.lastExamDate().toString(),
                        snapshot.complianceWindowDays(),
                        (int) daysSinceLastExam,
                        daysUntilDueSoon,
                        predictedDueSoonDate.toString()
                ));
            }
        }

        upcomingExpirations.sort(
                Comparator.comparingInt(UpcomingExpiration::daysUntilDueSoon)
                        .thenComparing(UpcomingExpiration::name)
        );

        List<SiteComplianceRate> siteRates = siteAccumulators.entrySet().stream()
                .map(entry -> {
                    String site = entry.getKey();
                    SiteAccumulator acc = entry.getValue();
                    double currentRate = percentage(acc.compliant, acc.total);
                    long predictedCompliant = Math.max(0, acc.compliant - acc.upcomingExpirations);
                    double predictedRate = percentage(predictedCompliant, acc.total);
                    return new SiteComplianceRate(
                            site,
                            acc.total,
                            acc.compliant,
                            acc.upcomingExpirations,
                            currentRate,
                            predictedRate
                    );
                })
                .sorted(Comparator.comparingDouble(SiteComplianceRate::currentComplianceRate))
                .toList();

        List<RepeatNonComplier> repeatNonCompliers = loadRepeatNonCompliers(context.measureVersionId(), context.measureName());

        return new RiskOutlookResult(
                upcomingExpirations.size(),
                upcomingExpirations,
                repeatNonCompliers,
                siteRates
        );
    }

    private MeasureContext loadMeasureContext(UUID measureId) {
        try {
            return jdbcTemplate.queryForObject(
                    """
                    SELECT mv.id AS measure_version_id, m.name AS measure_name
                    FROM measures m
                    JOIN measure_versions mv ON mv.measure_id = m.id
                    WHERE m.id = ?
                    ORDER BY mv.created_at DESC
                    LIMIT 1
                    """,
                    (rs, rowNum) -> new MeasureContext(
                            (UUID) rs.getObject("measure_version_id"),
                            rs.getString("measure_name")
                    ),
                    measureId
            );
        } catch (EmptyResultDataAccessException ex) {
            throw new IllegalArgumentException("Measure not found: " + measureId);
        }
    }

    private List<LatestOutcomeSnapshot> loadLatestOutcomeSnapshots(UUID measureVersionId) {
        return jdbcTemplate.query(
                """
                WITH ranked_outcomes AS (
                    SELECT
                        o.employee_id,
                        o.status,
                        o.evidence_json,
                        o.evaluated_at,
                        ROW_NUMBER() OVER (PARTITION BY o.employee_id ORDER BY o.evaluated_at DESC) AS rn
                    FROM outcomes o
                    WHERE o.measure_version_id = ?
                )
                SELECT
                    e.external_id,
                    e.name,
                    COALESCE(NULLIF(e.site, ''), 'Unknown') AS site,
                    ro.status,
                    NULLIF(ro.evidence_json -> 'why_flagged' ->> 'last_exam_date', '') AS last_exam_date,
                    CASE
                        WHEN (ro.evidence_json -> 'why_flagged' ->> 'compliance_window_days') ~ '^[0-9]+$'
                            THEN (ro.evidence_json -> 'why_flagged' ->> 'compliance_window_days')::INT
                        ELSE 365
                    END AS compliance_window_days
                FROM ranked_outcomes ro
                JOIN employees e ON e.id = ro.employee_id
                WHERE ro.rn = 1
                """,
                (rs, rowNum) -> mapLatestOutcomeSnapshot(rs),
                measureVersionId
        ).stream().filter(snapshot -> snapshot != null).toList();
    }

    private LatestOutcomeSnapshot mapLatestOutcomeSnapshot(ResultSet rs) throws SQLException {
        String lastExamDateText = rs.getString("last_exam_date");
        LocalDate lastExamDate = parseIsoDate(lastExamDateText);
        return new LatestOutcomeSnapshot(
                rs.getString("external_id"),
                rs.getString("name"),
                rs.getString("site"),
                rs.getString("status"),
                lastExamDate,
                rs.getInt("compliance_window_days")
        );
    }

    private List<RepeatNonComplier> loadRepeatNonCompliers(UUID measureVersionId, String measureName) {
        return jdbcTemplate.query(
                """
                WITH period_outcomes AS (
                    SELECT
                        o.employee_id,
                        o.status,
                        o.evaluated_at,
                        o.evaluation_period,
                        ROW_NUMBER() OVER (
                            PARTITION BY o.employee_id, o.evaluation_period
                            ORDER BY o.evaluated_at DESC
                        ) AS period_rank
                    FROM outcomes o
                    WHERE o.measure_version_id = ?
                ),
                ordered AS (
                    SELECT
                        po.employee_id,
                        e.external_id,
                        e.name,
                        COALESCE(NULLIF(e.site, ''), 'Unknown') AS site,
                        po.status,
                        po.evaluated_at,
                        SUM(
                            CASE WHEN po.status IN ('OVERDUE', 'MISSING_DATA') THEN 0 ELSE 1 END
                        ) OVER (
                            PARTITION BY po.employee_id
                            ORDER BY po.evaluated_at DESC
                            ROWS UNBOUNDED PRECEDING
                        ) AS break_group
                    FROM period_outcomes po
                    JOIN employees e ON e.id = po.employee_id
                    WHERE po.period_rank = 1
                ),
                current_streak AS (
                    SELECT
                        employee_id,
                        external_id,
                        name,
                        site,
                        COUNT(*) FILTER (WHERE status IN ('OVERDUE', 'MISSING_DATA')) AS streak
                    FROM ordered
                    WHERE break_group = 0
                    GROUP BY employee_id, external_id, name, site
                )
                SELECT external_id, name, site, streak
                FROM current_streak
                WHERE streak >= 3
                ORDER BY streak DESC, name ASC
                LIMIT 10
                """,
                (rs, rowNum) -> new RepeatNonComplier(
                        rs.getString("external_id"),
                        rs.getString("name"),
                        rs.getString("site"),
                        measureName,
                        rs.getLong("streak")
                ),
                measureVersionId
        );
    }

    private boolean isBecomingDueSoon(LatestOutcomeSnapshot snapshot, LocalDate today, int horizonDays) {
        if (!"COMPLIANT".equals(snapshot.status())) {
            return false;
        }
        if (snapshot.lastExamDate() == null) {
            return false;
        }
        int dueSoonThresholdDays = Math.max(snapshot.complianceWindowDays() - DUE_SOON_BUFFER_DAYS, 0);
        long daysSinceLastExam = ChronoUnit.DAYS.between(snapshot.lastExamDate(), today);
        if (daysSinceLastExam >= dueSoonThresholdDays) {
            return false;
        }
        long daysUntilDueSoon = dueSoonThresholdDays - daysSinceLastExam;
        return daysUntilDueSoon <= horizonDays;
    }

    private LocalDate parseIsoDate(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(value.trim());
        } catch (Exception ignored) {
            return null;
        }
    }

    private double percentage(long numerator, long denominator) {
        if (denominator <= 0) {
            return 0d;
        }
        double raw = (numerator * 100.0d) / denominator;
        return Math.round(raw * 10.0d) / 10.0d;
    }

    private record MeasureContext(UUID measureVersionId, String measureName) {}

    private record LatestOutcomeSnapshot(
            String externalId,
            String name,
            String site,
            String status,
            LocalDate lastExamDate,
            int complianceWindowDays
    ) {}

    private static final class SiteAccumulator {
        private long total;
        private long compliant;
        private long upcomingExpirations;
    }

    public record RiskOutlookResult(
            int upcomingNonCompliantCount,
            List<UpcomingExpiration> upcomingExpirations,
            List<RepeatNonComplier> repeatNonCompliers,
            List<SiteComplianceRate> siteComplianceRates
    ) {}

    public record UpcomingExpiration(
            String externalId,
            String name,
            String site,
            String measureName,
            String lastExamDate,
            int complianceWindowDays,
            int daysSinceLastExam,
            int daysUntilDueSoon,
            String predictedDueSoonDate
    ) {}

    public record RepeatNonComplier(
            String externalId,
            String name,
            String site,
            String measureName,
            long streakCount
    ) {}

    public record SiteComplianceRate(
            String site,
            long total,
            long compliant,
            long upcomingExpirations,
            double currentComplianceRate,
            double predictedComplianceRate
    ) {}
}
