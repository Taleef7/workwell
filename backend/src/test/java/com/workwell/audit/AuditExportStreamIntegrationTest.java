package com.workwell.audit;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * #150 M9: the audit export streams the full ledger to the response straight from a DB cursor, so it
 * never materializes the whole ledger (a {@code List<Map>} plus a ~12MB {@code String}) in heap. The
 * streamed bytes keep the exact CSV contract — header row + quoted cells.
 */
@SpringBootTest
class AuditExportStreamIntegrationTest extends AbstractIntegrationTest {

    private static final String HEADER = "timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail";

    @Autowired
    private AuditExportService auditExportService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void reset() {
        jdbcTemplate.execute("TRUNCATE TABLE audit_events CASCADE");
    }

    @Test
    void streamsTheLedgerWithHeaderAndRows() {
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, actor, payload_json, occurred_at) "
                        + "VALUES ('CASE_ASSIGNED', 'case', 'cm@workwell.dev', ?::jsonb, NOW())",
                "{\"assignee\":\"cm@x\"}");

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        auditExportService.streamCsv(out);
        String csv = out.toString(StandardCharsets.UTF_8);

        String[] lines = csv.split("\n");
        assertThat(lines[0]).isEqualTo(HEADER);
        assertThat(csv).contains("CASE_ASSIGNED").contains("cm@workwell.dev").contains("assignee");
    }

    @Test
    void emptyLedgerStreamsJustTheHeader() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        auditExportService.streamCsv(out);
        assertThat(out.toString(StandardCharsets.UTF_8).trim()).isEqualTo(HEADER);
    }
}
