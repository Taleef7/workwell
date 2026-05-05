package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.measure.AudiogramDemoService;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@Testcontainers
class RunPersistenceServiceIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.flyway.url", postgres::getJdbcUrl);
        registry.add("spring.flyway.user", postgres::getUsername);
        registry.add("spring.flyway.password", postgres::getPassword);
    }

    @Autowired
    private AudiogramDemoService audiogramDemoService;

    @Autowired
    private RunPersistenceService runPersistenceService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void audiogramRunsUpsertCasesIdempotently() {
        var run = audiogramDemoService.run();
        var runId = java.util.UUID.fromString(run.runId());

        assertThat(count("SELECT COUNT(*) FROM runs")).isEqualTo(1L);
        assertThat(count("SELECT COUNT(*) FROM outcomes")).isEqualTo(15L);
        assertThat(count("SELECT COUNT(*) FROM cases")).isEqualTo(10L);
        assertThat(count("SELECT COUNT(*) FROM cases WHERE status = 'OPEN'")).isEqualTo(10L);
        assertThat(count("SELECT COUNT(*) FROM audit_events WHERE event_type IN ('CASE_CREATED', 'CASE_UPDATED', 'CASE_CLOSED')")).isEqualTo(10L);
        assertThat(runPersistenceService.loadOutcomeExportRows(runId)).hasSize(15);

        audiogramDemoService.run();

        assertThat(count("SELECT COUNT(*) FROM runs")).isEqualTo(2L);
        assertThat(count("SELECT COUNT(*) FROM outcomes")).isEqualTo(30L);
        assertThat(count("SELECT COUNT(*) FROM cases")).isEqualTo(10L);
        assertThat(count("SELECT COUNT(*) FROM audit_events WHERE event_type IN ('CASE_CREATED', 'CASE_UPDATED', 'CASE_CLOSED')")).isEqualTo(20L);
    }

    private Long count(String sql) {
        return jdbcTemplate.queryForObject(sql, Long.class);
    }
}
