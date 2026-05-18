package com.workwell.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * OpenAPI metadata. Only active when {@code workwell.swagger.enabled=true};
 * SecurityConfig denies the Swagger paths otherwise (production keeps it off).
 */
@Configuration
@ConditionalOnProperty(name = "workwell.swagger.enabled", havingValue = "true")
public class OpenApiConfig {

    @Bean
    public OpenAPI workwellOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("WorkWell Measure Studio API")
                        .version("v1")
                        .description("Occupational health compliance measure authoring, "
                                + "CQL evaluation, case management, and audit trail API.")
                        .contact(new Contact().name("WorkWell Engineering")))
                .addSecurityItem(new SecurityRequirement().addList("bearerAuth"))
                .components(new Components()
                        .addSecuritySchemes("bearerAuth",
                                new SecurityScheme()
                                        .type(SecurityScheme.Type.HTTP)
                                        .scheme("bearer")
                                        .bearerFormat("JWT")));
    }
}
