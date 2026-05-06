package com.workwell.admin;

import com.workwell.run.ScheduledRunService;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;

@Service
public class SchedulerAdminService {
    private final ScheduledRunService scheduledRunService;
    private final JdbcTemplate jdbcTemplate;
    private final String cronExpression;

    public SchedulerAdminService(
            ScheduledRunService scheduledRunService,
            JdbcTemplate jdbcTemplate,
            @Value("${workwell.scheduler.cron:0 0 6 * * *}") String cronExpression
    ) {
        this.scheduledRunService = scheduledRunService;
        this.jdbcTemplate = jdbcTemplate;
        this.cronExpression = cronExpression;
    }

    public SchedulerStatus status() {
        SchedulerRunSnapshot lastRun = latestScheduledRun();
        return new SchedulerStatus(
                scheduledRunService.isSchedulerEnabled(),
                cronExpression,
                nextFireAt(cronExpression),
                lastRun.lastRunAt(),
                lastRun.lastRunStatus()
        );
    }

    public SchedulerStatus updateEnabled(boolean enabled) {
        scheduledRunService.setSchedulerEnabled(enabled);
        return status();
    }

    private Instant nextFireAt(String cron) {
        CronExpression expression = CronExpression.parse(cron);
        ZonedDateTime next = expression.next(ZonedDateTime.now(ZoneId.systemDefault()));
        return next == null ? null : next.toInstant();
    }

    private SchedulerRunSnapshot latestScheduledRun() {
        try {
            Map<String, Object> row = jdbcTemplate.queryForMap(
                    "SELECT started_at, status FROM runs WHERE trigger_type = 'scheduler' ORDER BY started_at DESC LIMIT 1"
            );
            Timestamp startedAt = (Timestamp) row.get("started_at");
            String status = row.get("status") == null ? "unknown" : row.get("status").toString();
            return new SchedulerRunSnapshot(startedAt == null ? null : startedAt.toInstant(), status);
        } catch (EmptyResultDataAccessException ex) {
            return new SchedulerRunSnapshot(null, "never");
        }
    }

    public record SchedulerStatus(
            boolean enabled,
            String cron,
            Instant nextFireAt,
            Instant lastRunAt,
            String lastRunStatus
    ) {
    }

    private record SchedulerRunSnapshot(Instant lastRunAt, String lastRunStatus) {
    }
}

