package com.workwell.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class JwtServiceTest {

    @Test
    void failsFastWhenAuthEnabledAndDefaultSecretIsUsed() {
        assertThrows(IllegalStateException.class, () -> new JwtService(
                new ObjectMapper(),
                "workwell-demo-secret-change-me",
                28800,
                true
        ));
    }

    @Test
    void issuesAndValidatesTokensWithCustomSecret() {
        JwtService service = new JwtService(new ObjectMapper(), "super-secret-value", 60, true);

        String token = service.issueToken("author@workwell.dev", "ROLE_AUTHOR");
        assertNotNull(token);

        Optional<JwtService.JwtPrincipal> principal = service.parseAndValidate(token);
        assertEquals("author@workwell.dev", principal.map(JwtService.JwtPrincipal::email).orElseThrow());
        assertEquals("ROLE_AUTHOR", principal.map(JwtService.JwtPrincipal::role).orElseThrow());
    }
}
