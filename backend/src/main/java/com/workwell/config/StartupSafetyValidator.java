package com.workwell.config;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

@Component
public class StartupSafetyValidator implements ApplicationRunner {
    private static final Set<String> PRODUCTION_LIKE_PROFILES = Set.of("prod", "production", "fly", "staging");
    private static final String DEFAULT_JWT_SECRET = "workwell-demo-secret-change-me";
    private static final Set<String> KNOWN_WEAK_JWT_SECRETS = new HashSet<>(Set.of(
            "change-me",
            "dev-secret",
            "secret",
            "workwell123",
            "workwell123!",
            "workwell-demo-secret-change-me"
    ));

    private final Environment environment;
    private final boolean authEnabled;
    private final String jwtSecret;
    private final String allowedOriginsConfig;
    private final boolean demoEnabled;
    private final boolean allowPublicDemo;

    public StartupSafetyValidator(
            Environment environment,
            @Value("${workwell.auth.enabled:true}") boolean authEnabled,
            @Value("${workwell.auth.jwt-secret:" + DEFAULT_JWT_SECRET + "}") String jwtSecret,
            @Value("${workwell.cors.allowed-origins:http://localhost:3000,http://127.0.0.1:3000}") String allowedOriginsConfig,
            @Value("${workwell.demo.enabled:false}") boolean demoEnabled,
            @Value("${workwell.demo.allow-public-demo:false}") boolean allowPublicDemo
    ) {
        this.environment = environment;
        this.authEnabled = authEnabled;
        this.jwtSecret = jwtSecret;
        this.allowedOriginsConfig = allowedOriginsConfig;
        this.demoEnabled = demoEnabled;
        this.allowPublicDemo = allowPublicDemo;
    }

    @Override
    public void run(ApplicationArguments args) {
        validate(
                isProductionLike(environment),
                authEnabled,
                jwtSecret,
                allowedOriginsConfig,
                demoEnabled,
                allowPublicDemo
        );
    }

    static void validate(
            boolean productionLike,
            boolean authEnabled,
            String jwtSecret,
            String allowedOriginsConfig,
            boolean demoEnabled,
            boolean allowPublicDemo
    ) {
        if (!productionLike) {
            return;
        }

        if (!authEnabled) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: workwell.auth.enabled=false is not allowed in production."
            );
        }

        if (isWeakJwtSecret(jwtSecret)) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: workwell.auth.jwt-secret must be at least 32 characters and not a demo/default value in production."
            );
        }

        List<String> allowedOrigins = SecurityConfig.parseAllowedOrigins(allowedOriginsConfig);
        if (allowedOrigins.isEmpty()) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: workwell.cors.allowed-origins must define at least one exact origin in production."
            );
        }

        for (String origin : allowedOrigins) {
            validateCorsOrigin(origin);
        }

        if (demoEnabled && !allowPublicDemo) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: workwell.demo.enabled=true is not allowed in production unless workwell.demo.allow-public-demo=true."
            );
        }
    }

    private static boolean isProductionLike(Environment environment) {
        Set<String> activeProfiles = new HashSet<>(Arrays.asList(environment.getActiveProfiles()));
        for (String profile : activeProfiles) {
            if (PRODUCTION_LIKE_PROFILES.contains(profile.toLowerCase(Locale.ROOT))) {
                return true;
            }
        }

        String explicitEnvironment = environment.getProperty("workwell.environment", "");
        return "production".equalsIgnoreCase(explicitEnvironment) || "prod".equalsIgnoreCase(explicitEnvironment);
    }

    private static boolean isWeakJwtSecret(String secret) {
        if (!StringUtils.hasText(secret)) {
            return true;
        }

        String normalized = secret.trim();
        if (normalized.length() < 32) {
            return true;
        }

        String lower = normalized.toLowerCase(Locale.ROOT);
        return KNOWN_WEAK_JWT_SECRETS.contains(lower);
    }

    private static void validateCorsOrigin(String origin) {
        if (!StringUtils.hasText(origin)) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: workwell.cors.allowed-origins contains a blank origin in production."
            );
        }

        String trimmed = origin.trim();
        if (trimmed.contains("*")) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: wildcard CORS origins are not allowed in production."
            );
        }

        URI uri;
        try {
            uri = URI.create(trimmed);
        } catch (IllegalArgumentException ex) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: invalid CORS origin in production: " + trimmed,
                    ex
            );
        }

        String host = uri.getHost();
        if (!StringUtils.hasText(uri.getScheme()) || !StringUtils.hasText(host)) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: invalid CORS origin in production: " + trimmed
            );
        }

        String normalizedHost = host.toLowerCase(Locale.ROOT);
        if (normalizedHost.equals("localhost")
                || normalizedHost.equals("127.0.0.1")
                || normalizedHost.equals("::1")
                || normalizedHost.equals("0.0.0.0")) {
            throw new IllegalStateException(
                    "Unsafe WorkWell configuration: localhost CORS origins are not allowed in production."
            );
        }
    }
}
