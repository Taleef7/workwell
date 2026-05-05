package com.workwell.web;

import com.workwell.admin.IntegrationHealthService;
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

    public AdminController(IntegrationHealthService integrationHealthService) {
        this.integrationHealthService = integrationHealthService;
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
}
