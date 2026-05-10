package com.workwell.config;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.mock.env.MockEnvironment;

class StartupSafetyValidatorTest {
    private static final String EXACT_FRONTEND_ORIGIN = "https://frontend-seven-eta-24.vercel.app";
    private static final String STRONG_JWT_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    @Test
    void localDevelopmentCanUseLocalhostOrigins() {
        assertThatCode(() -> StartupSafetyValidator.validate(
                false,
                false,
                "dev-secret",
                "http://localhost:3000,http://127.0.0.1:3000",
                true,
                false
        )).doesNotThrowAnyException();
    }

    @Test
    void productionLikeStartupFailsWhenAuthIsDisabled() {
        assertThatThrownBy(() -> StartupSafetyValidator.validate(
                true,
                false,
                STRONG_JWT_SECRET,
                EXACT_FRONTEND_ORIGIN,
                false,
                false
        ))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("workwell.auth.enabled=false");
    }

    @Test
    void productionLikeStartupFailsWhenWildcardCorsIsConfigured() {
        assertThatThrownBy(() -> StartupSafetyValidator.validate(
                true,
                true,
                STRONG_JWT_SECRET,
                "https://*.vercel.app",
                false,
                false
        ))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("wildcard CORS origins");
    }

    @Test
    void productionLikeStartupFailsWhenLocalhostCorsIsConfigured() {
        assertThatThrownBy(() -> StartupSafetyValidator.validate(
                true,
                true,
                STRONG_JWT_SECRET,
                "http://localhost:3000",
                false,
                false
        ))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("localhost CORS origins");
    }

    @Test
    void productionLikeStartupFailsWhenJwtSecretIsWeak() {
        assertThatThrownBy(() -> StartupSafetyValidator.validate(
                true,
                true,
                "workwell-demo-secret-change-me",
                EXACT_FRONTEND_ORIGIN,
                false,
                false
        ))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("workwell.auth.jwt-secret");
    }

    @Test
    void productionLikeStartupAllowsExactCorsAndStrongSecret() {
        assertThatCode(() -> StartupSafetyValidator.validate(
                true,
                true,
                STRONG_JWT_SECRET,
                EXACT_FRONTEND_ORIGIN,
                false,
                false
        )).doesNotThrowAnyException();
    }

    @Test
    void productionLikeStartupFailsWhenDemoModeIsEnabledWithoutOverride() {
        assertThatThrownBy(() -> StartupSafetyValidator.validate(
                true,
                true,
                STRONG_JWT_SECRET,
                EXACT_FRONTEND_ORIGIN,
                true,
                false
        ))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("workwell.demo.enabled=true");
    }

    @Test
    void productionLikeStartupAllowsDemoModeWhenPublicDemoOverrideIsExplicit() {
        assertThatCode(() -> StartupSafetyValidator.validate(
                true,
                true,
                STRONG_JWT_SECRET,
                EXACT_FRONTEND_ORIGIN,
                true,
                true
        )).doesNotThrowAnyException();
    }

    @Test
    void productionEnvironmentPropertyAlsoTriggersValidation() {
        MockEnvironment environment = new MockEnvironment().withProperty("workwell.environment", "production");
        StartupSafetyValidator validator = new StartupSafetyValidator(
                environment,
                false,
                STRONG_JWT_SECRET,
                EXACT_FRONTEND_ORIGIN,
                false,
                false
        );

        assertThatThrownBy(() -> validator.run(new DefaultApplicationArguments()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("workwell.auth.enabled=false");
    }
}
