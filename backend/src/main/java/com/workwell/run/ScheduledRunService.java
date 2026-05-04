package com.workwell.run;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class ScheduledRunService {
    private static final Logger log = LoggerFactory.getLogger(ScheduledRunService.class);

    private final AllProgramsRunService allProgramsRunService;

    @Value("${workwell.scheduler.enabled:false}")
    private boolean schedulerEnabled;

    public ScheduledRunService(AllProgramsRunService allProgramsRunService) {
        this.allProgramsRunService = allProgramsRunService;
    }

    @Scheduled(cron = "${workwell.scheduler.cron:0 0 6 * * *}")
    public void runScheduledAllPrograms() {
        if (!schedulerEnabled) {
            return;
        }
        try {
            var result = allProgramsRunService.runAllPrograms("All Programs", "scheduler");
            log.info("Scheduled all-programs run completed. runId={}, measures={}", result.runId(), result.activeMeasuresExecuted());
        } catch (RuntimeException ex) {
            log.error("Scheduled all-programs run failed: {}", ex.getMessage(), ex);
        }
    }
}

