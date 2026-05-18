package com.workwell.web.filter;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.workwell.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * Re-enables rate limiting (disabled for the rest of the suite) and verifies the
 * login endpoint returns a JSON 429 with Retry-After after the per-IP limit.
 */
@SpringBootTest(properties = {
        "workwell.auth.enabled=true",
        "workwell.auth.jwt-secret=test-secret-for-rate-limit-integration",
        "workwell.ratelimit.enabled=true"
})
@AutoConfigureMockMvc
class RateLimitFilterIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void loginReturns429AfterTenAttemptsFromSameIp() throws Exception {
        String body = "{\"email\":\"nobody@workwell.dev\",\"password\":\"wrong-password\"}";

        // First 10 attempts consume the bucket (each returns 401 invalid-credentials).
        for (int i = 0; i < 10; i++) {
            mockMvc.perform(post("/api/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body));
        }

        MvcResult limited = mockMvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn();

        assertThat(limited.getResponse().getStatus()).isEqualTo(429);
        assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();
        assertThat(limited.getResponse().getContentAsString())
                .contains("rate_limit_exceeded")
                .contains("retryAfterSeconds");
    }

    @Test
    void preflightOptionsRequestsAreNotRateLimited() throws Exception {
        for (int i = 0; i < 30; i++) {
            MvcResult result = mockMvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .options("/api/auth/login")
                            .header("Origin", "http://localhost:3000")
                            .header("Access-Control-Request-Method", "POST"))
                    .andReturn();
            assertThat(result.getResponse().getStatus()).isNotEqualTo(429);
        }
    }
}
