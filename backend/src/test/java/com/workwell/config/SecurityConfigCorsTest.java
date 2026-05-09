package com.workwell.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.workwell.security.JwtService;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.cors.CorsConfiguration;

class SecurityConfigCorsTest {
    @Test
    void exactConfiguredOriginIsAllowedButPreviewOriginsAreRejected() {
        @SuppressWarnings("unchecked")
        ObjectProvider<JwtService> jwtServiceProvider = mock(ObjectProvider.class);
        SecurityConfig config = new SecurityConfig(
                jwtServiceProvider,
                true,
                "https://frontend-seven-eta-24.vercel.app"
        );

        CorsConfiguration corsConfiguration = resolveCorsConfiguration(config);

        assertThat(corsConfiguration.checkOrigin("https://frontend-seven-eta-24.vercel.app"))
                .isEqualTo("https://frontend-seven-eta-24.vercel.app");
        assertThat(corsConfiguration.checkOrigin("https://random-preview.vercel.app"))
                .isNull();
    }

    @Test
    void localhostOriginsCanBeAllowedForLocalDevelopment() {
        @SuppressWarnings("unchecked")
        ObjectProvider<JwtService> jwtServiceProvider = mock(ObjectProvider.class);
        SecurityConfig config = new SecurityConfig(
                jwtServiceProvider,
                true,
                "http://localhost:3000,http://127.0.0.1:3000"
        );

        CorsConfiguration corsConfiguration = resolveCorsConfiguration(config);

        assertThat(corsConfiguration.checkOrigin("http://localhost:3000"))
                .isEqualTo("http://localhost:3000");
        assertThat(corsConfiguration.checkOrigin("http://127.0.0.1:3000"))
                .isEqualTo("http://127.0.0.1:3000");
    }

    @SuppressWarnings("unchecked")
    private static CorsConfiguration resolveCorsConfiguration(SecurityConfig config) {
        HttpServletRequest request = new MockHttpServletRequest("GET", "/api/measures");
        return (CorsConfiguration) config.corsConfigurationSource().getCorsConfiguration(request);
    }
}
