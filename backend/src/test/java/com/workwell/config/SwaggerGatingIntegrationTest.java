package com.workwell.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.workwell.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * With {@code workwell.swagger.enabled=false} (production default), Swagger UI and
 * the OpenAPI docs must be blocked by SecurityConfig.
 */
@SpringBootTest(properties = {
        "workwell.auth.enabled=true",
        "workwell.auth.jwt-secret=test-secret-for-swagger-gating",
        "workwell.swagger.enabled=false"
})
@AutoConfigureMockMvc
class SwaggerGatingIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void swaggerUiIsBlockedWhenDisabled() throws Exception {
        MvcResult result = mockMvc.perform(get("/swagger-ui/index.html")).andReturn();
        assertThat(result.getResponse().getStatus()).isIn(401, 403, 404);
    }

    @Test
    void apiDocsAreBlockedWhenDisabled() throws Exception {
        MvcResult result = mockMvc.perform(get("/v3/api-docs")).andReturn();
        assertThat(result.getResponse().getStatus()).isIn(401, 403, 404);
    }
}
