package com.workwell.web;

import com.workwell.admin.IntegrationHealthService;
import com.workwell.admin.OutreachTemplateService;
import com.workwell.admin.SchedulerAdminService;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class AdminController {
    private final IntegrationHealthService integrationHealthService;
    private final SchedulerAdminService schedulerAdminService;
    private final OutreachTemplateService outreachTemplateService;

    public AdminController(
            IntegrationHealthService integrationHealthService,
            SchedulerAdminService schedulerAdminService,
            OutreachTemplateService outreachTemplateService
    ) {
        this.integrationHealthService = integrationHealthService;
        this.schedulerAdminService = schedulerAdminService;
        this.outreachTemplateService = outreachTemplateService;
    }

    @GetMapping("/api/admin/integrations")
    public List<IntegrationHealthService.IntegrationHealth> listIntegrations() {
        return integrationHealthService.listHealth();
    }

    @PostMapping("/api/admin/integrations/{integration}/sync")
    public IntegrationHealthService.IntegrationHealth syncIntegration(
            @PathVariable String integration,
            @RequestParam(name = "actor", defaultValue = "admin-user") String actor
    ) {
        try {
            return integrationHealthService.triggerManualSync(integration, actor);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @GetMapping("/api/admin/scheduler")
    public SchedulerAdminService.SchedulerStatus schedulerStatus() {
        return schedulerAdminService.status();
    }

    @PostMapping("/api/admin/scheduler")
    public SchedulerAdminService.SchedulerStatus updateScheduler(@RequestParam(name = "enabled") boolean enabled) {
        return schedulerAdminService.updateEnabled(enabled);
    }

    @GetMapping("/api/admin/outreach-templates")
    public List<OutreachTemplateService.OutreachTemplate> outreachTemplates() {
        return outreachTemplateService.listTemplates();
    }
}
