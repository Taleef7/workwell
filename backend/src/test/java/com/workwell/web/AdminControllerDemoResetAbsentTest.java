package com.workwell.web;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.admin.DataReadinessService;
import com.workwell.admin.IntegrationHealthService;
import com.workwell.admin.OutreachDeliveryLogService;
import com.workwell.admin.OutreachTemplateService;
import com.workwell.admin.SchedulerAdminService;
import com.workwell.admin.WaiverService;
import com.workwell.audit.AuditQueryService;
import com.workwell.measure.ValueSetGovernanceService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Verifies the production safeguard: when {@code DemoResetService} is not registered
 * (it is {@code @Profile("!prod")}, so absent in prod), the optional injection is empty
 * and {@code POST /api/admin/demo-reset} returns 403 rather than failing to start.
 *
 * <p>No {@code @MockBean DemoResetService} is declared here, so the
 * {@code Optional<DemoResetService>} constructor parameter resolves to empty.
 */
@WebMvcTest(AdminController.class)
@AutoConfigureMockMvc(addFilters = false)
@WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
class AdminControllerDemoResetAbsentTest {
    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private IntegrationHealthService integrationHealthService;

    @MockBean
    private SchedulerAdminService schedulerAdminService;

    @MockBean
    private OutreachTemplateService outreachTemplateService;

    @MockBean
    private WaiverService waiverService;

    @MockBean
    private AuditQueryService auditQueryService;

    @MockBean
    private DataReadinessService dataReadinessService;

    @MockBean
    private ValueSetGovernanceService valueSetGovernanceService;

    @MockBean
    private OutreachDeliveryLogService outreachDeliveryLogService;

    @Test
    void demoResetReturnsForbiddenWhenServiceAbsent() throws Exception {
        mockMvc.perform(post("/api/admin/demo-reset"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error").value("Demo reset is not available in production"));
    }
}
