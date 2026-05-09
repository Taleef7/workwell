package com.workwell.config;

import com.workwell.security.JwtAuthFilter;
import com.workwell.security.JwtService;
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

import java.util.List;

@Configuration
public class SecurityConfig {
    private final ObjectProvider<JwtService> jwtServiceProvider;
    private final boolean authEnabled;

    public SecurityConfig(
            ObjectProvider<JwtService> jwtServiceProvider,
            @Value("${workwell.auth.enabled:true}") boolean authEnabled
    ) {
        this.jwtServiceProvider = jwtServiceProvider;
        this.authEnabled = authEnabled;
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
                .cors(Customizer.withDefaults())
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .httpBasic(basic -> basic.disable());

        if (!authEnabled) {
            http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        } else {
            http.authorizeHttpRequests(auth -> auth
                    .requestMatchers("/api/auth/login", "/actuator/health", "/api/health").permitAll()
                    .requestMatchers("/sse", "/mcp/**").hasAnyAuthority("ROLE_ADMIN", "ROLE_CASE_MANAGER", "ROLE_MCP_CLIENT")
                    .requestMatchers("/api/admin/**").hasAuthority("ROLE_ADMIN")
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
                http.addFilterBefore(new JwtAuthFilter(jwtService), UsernamePasswordAuthenticationFilter.class);
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
        config.setAllowedOriginPatterns(List.of(
                "https://workwell-measure-studio.vercel.app",
                "https://*.vercel.app",
                "http://localhost:3000"
        ));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        config.setAllowCredentials(true);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }
}
