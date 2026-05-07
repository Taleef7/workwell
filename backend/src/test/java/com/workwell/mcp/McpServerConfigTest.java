package com.workwell.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.measure.MeasureService;
import com.workwell.run.RunPersistenceService;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.WebMvcSseServerTransportProvider;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class McpServerConfigTest {
    @Test
    void registersAllExpectedTools() {
        McpServerConfig config = new McpServerConfig();
        ObjectMapper objectMapper = new ObjectMapper();
        WebMvcSseServerTransportProvider transport = config.mcpTransportProvider(objectMapper);

        McpSyncServer server = config.mcpServer(
                transport,
                objectMapper,
                mock(CaseFlowService.class),
                mock(RunPersistenceService.class),
                mock(MeasureService.class),
                mock(JdbcTemplate.class)
        );

        assertThat(server).isNotNull();
        assertThat(server.getServerInfo().name()).isEqualTo("workwell-mcp");
        assertThat(server.getServerInfo().version()).isEqualTo("1.1.0");
        assertThat(server.getServerCapabilities()).isNotNull();
    }
}
