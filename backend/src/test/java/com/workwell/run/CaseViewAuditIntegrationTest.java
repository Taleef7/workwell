package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.hasItem;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.AbstractIntegrationTest;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class CaseViewAuditIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MockMvc mockMvc;

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void openingCaseWritesAccessAuditEventAndAdminFilterShowsIt() throws Exception {
        resetTables();
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");

        UUID caseId = jdbcTemplate.queryForObject(
                "SELECT id FROM cases ORDER BY created_at ASC LIMIT 1",
                UUID.class
        );
        assertThat(caseId).isNotNull();

        mockMvc.perform(get("/api/cases/{caseId}", caseId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.timeline[*].eventType").value(not(hasItem("CASE_VIEWED"))));

        Integer viewedCount = awaitViewedAuditEvent(caseId, "admin@workwell.dev");
        assertThat(viewedCount).isEqualTo(1);

        mockMvc.perform(get("/api/admin/audit-events").param("scope", "access"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].eventType").value("CASE_VIEWED"))
                .andExpect(jsonPath("$[0].actor").value("admin@workwell.dev"));
    }

    private Integer awaitViewedAuditEvent(UUID caseId, String actor) throws InterruptedException {
        Integer count = 0;
        for (int i = 0; i < 30; i++) {
            count = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM audit_events WHERE event_type = 'CASE_VIEWED' AND ref_case_id = ? AND actor = ?",
                    Integer.class,
                    caseId,
                    actor
            );
            if (count != null && count > 0) {
                break;
            }
            Thread.sleep(100L);
        }
        return count;
    }

    private void resetTables() {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, outreach_records, scheduled_appointments, waivers CASCADE");
    }
}
