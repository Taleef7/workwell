package com.workwell.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.benmanes.caffeine.cache.Cache;
import com.workwell.security.JwtAuthFilter;
import com.workwell.security.JwtService;
import com.workwell.web.filter.RateLimitFilter;
import io.github.bucket4j.Bucket;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.util.StringUtils;

import java.util.Arrays;
import java.util.List;

@Configuration
public class SecurityConfig {
    private final ObjectProvider<JwtService> jwtServiceProvider;
    private final boolean authEnabled;
    private final String allowedOriginsConfig;
    private final boolean swaggerEnabled;
    private final boolean rateLimitEnabled;
    private final Cache<String, Bucket> rateLimitCache;
    private final ObjectMapper objectMapper;

    @org.springframework.beans.factory.annotation.Autowired
    public SecurityConfig(
            ObjectProvider<JwtService> jwtServiceProvider,
            @Value("${workwell.auth.enabled:true}") boolean authEnabled,
            @Value("${workwell.cors.allowed-origins:http://localhost:3000,http://127.0.0.1:3000}") String allowedOriginsConfig,
            @Value("${workwell.swagger.enabled:false}") boolean swaggerEnabled,
            @Value("${workwell.ratelimit.enabled:true}") boolean rateLimitEnabled,
            Cache<String, Bucket> rateLimitCache,
            ObjectMapper objectMapper
    ) {
        this.jwtServiceProvider = jwtServiceProvider;
        this.authEnabled = authEnabled;
        this.allowedOriginsConfig = allowedOriginsConfig;
        this.swaggerEnabled = swaggerEnabled;
        this.rateLimitEnabled = rateLimitEnabled;
        this.rateLimitCache = rateLimitCache;
        this.objectMapper = objectMapper;
    }

    /**
     * Backward-compatible constructor used by focused unit tests that only exercise
     * CORS. Rate limiting is disabled and Swagger is off in this form.
     */
    SecurityConfig(
            ObjectProvider<JwtService> jwtServiceProvider,
            boolean authEnabled,
            String allowedOriginsConfig
    ) {
        this(jwtServiceProvider, authEnabled, allowedOriginsConfig, false, false,
                new RateLimitConfig().rateLimitCache(), new ObjectMapper());
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
                .cors(Customizer.withDefaults())
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .httpBasic(basic -> basic.disable());

        // Gate Swagger UI / OpenAPI docs unless explicitly enabled (production keeps them off).
        if (!swaggerEnabled) {
            http.authorizeHttpRequests(auth -> auth
                    .requestMatchers("/swagger-ui/**", "/swagger-ui.html", "/v3/api-docs/**", "/v3/api-docs")
                    .denyAll()
            );
        }

        RateLimitFilter rateLimitFilter = new RateLimitFilter(rateLimitCache, objectMapper, rateLimitEnabled);

        if (!authEnabled) {
            http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
            http.addFilterBefore(rateLimitFilter, UsernamePasswordAuthenticationFilter.class);
        } else {
            http.authorizeHttpRequests(auth -> auth
                    .requestMatchers("/api/auth/login", "/api/auth/refresh", "/api/auth/logout", "/actuator/health", "/api/health", "/api/version").permitAll()
                    .requestMatchers("/sse", "/mcp/**").hasAnyAuthority("ROLE_ADMIN", "ROLE_CASE_MANAGER", "ROLE_MCP_CLIENT")
                    .requestMatchers("/api/admin/**").hasAuthority("ROLE_ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/cases/*/evidence").hasAnyAuthority("ROLE_CASE_MANAGER", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.GET, "/api/cases/*/evidence").hasAnyAuthority("ROLE_CASE_MANAGER", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.GET, "/api/evidence/*/download").hasAnyAuthority("ROLE_CASE_MANAGER", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/measures/*/approve").hasAnyAuthority("ROLE_APPROVER", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/measures/*/activate").hasAnyAuthority("ROLE_APPROVER", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/measures/*/deprecate").hasAuthority("ROLE_ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/measures/*/status").hasAnyAuthority("ROLE_APPROVER", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.PUT, "/api/measures/*/spec").hasAnyAuthority("ROLE_AUTHOR", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.PUT, "/api/measures/*/cql").hasAnyAuthority("ROLE_AUTHOR", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.PUT, "/api/measures/*/tests").hasAnyAuthority("ROLE_AUTHOR", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/measures/**").hasAnyAuthority("ROLE_AUTHOR", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/runs/**").hasAnyAuthority("ROLE_CASE_MANAGER", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.POST, "/api/cases/**").hasAnyAuthority("ROLE_CASE_MANAGER", "ROLE_ADMIN")
                    .requestMatchers(HttpMethod.GET, "/api/**").authenticated()
                    .requestMatchers("/api/**").authenticated()
                    .anyRequest().permitAll()
            );
            JwtService jwtService = jwtServiceProvider.getIfAvailable();
            if (jwtService != null) {
                JwtAuthFilter jwtAuthFilter = new JwtAuthFilter(jwtService);
                http.addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class);
                // Run rate limiting after auth so per-user keys see the resolved principal.
                http.addFilterAfter(rateLimitFilter, JwtAuthFilter.class);
            } else {
                http.addFilterBefore(rateLimitFilter, UsernamePasswordAuthenticationFilter.class);
            }
        }
        return http.build();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(parseAllowedOrigins(allowedOriginsConfig));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        config.setAllowCredentials(true);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }

    static List<String> parseAllowedOrigins(String configuredOrigins) {
        return Arrays.stream(StringUtils.commaDelimitedListToStringArray(configuredOrigins))
                .map(String::trim)
                .filter(StringUtils::hasText)
                .toList();
    }
}
