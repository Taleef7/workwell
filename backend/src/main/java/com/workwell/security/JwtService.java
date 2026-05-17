package com.workwell.security;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Optional;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class JwtService {
    private static final String HMAC_ALGO = "HmacSHA256";
    private static final String DEFAULT_SECRET = "workwell-demo-secret-change-me";
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {
    };

    private final ObjectMapper objectMapper;
    private final byte[] secret;
    private final long accessTtlSeconds;
    private final long refreshTtlSeconds;

    public JwtService(
            ObjectMapper objectMapper,
            @Value("${workwell.auth.jwt-secret:" + DEFAULT_SECRET + "}") String secret,
            @Value("${workwell.auth.access-ttl-seconds:900}") long accessTtlSeconds,
            @Value("${workwell.auth.enabled:true}") boolean authEnabled,
            @Value("${workwell.auth.refresh-ttl-seconds:28800}") long refreshTtlSeconds
    ) {
        this.objectMapper = objectMapper;
        if (authEnabled && (secret == null || secret.isBlank() || DEFAULT_SECRET.equals(secret))) {
            throw new IllegalStateException("workwell.auth.jwt-secret must be configured when workwell.auth.enabled=true");
        }
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.accessTtlSeconds = accessTtlSeconds;
        this.refreshTtlSeconds = refreshTtlSeconds;
    }

    /**
     * Backward-compatible constructor: a single TTL is used for access tokens and the
     * refresh TTL defaults to 8h. Retained so existing direct callers/tests keep working.
     */
    public JwtService(
            ObjectMapper objectMapper,
            String secret,
            long accessTtlSeconds,
            boolean authEnabled
    ) {
        this(objectMapper, secret, accessTtlSeconds, authEnabled, 28800);
    }

    public String issueToken(String email, String role) {
        try {
            long now = Instant.now().getEpochSecond();
            String header = base64Url(objectMapper.writeValueAsBytes(Map.of("alg", "HS256", "typ", "JWT")));
            String payload = base64Url(objectMapper.writeValueAsBytes(Map.of(
                    "sub", email,
                    "role", role,
                    "iat", now,
                    "exp", now + accessTtlSeconds
            )));
            String signature = base64Url(sign((header + "." + payload).getBytes(StandardCharsets.UTF_8)));
            return header + "." + payload + "." + signature;
        } catch (Exception ex) {
            throw new IllegalStateException("Unable to issue JWT", ex);
        }
    }

    /**
     * Issues a long-lived refresh token carrying a {@code refresh:true} claim.
     * Refresh tokens cannot authenticate normal API calls (see {@link #parseAndValidate}).
     */
    public String issueRefreshToken(String email) {
        try {
            long now = Instant.now().getEpochSecond();
            String header = base64Url(objectMapper.writeValueAsBytes(Map.of("alg", "HS256", "typ", "JWT")));
            String payload = base64Url(objectMapper.writeValueAsBytes(Map.of(
                    "sub", email,
                    "refresh", true,
                    "iat", now,
                    "exp", now + refreshTtlSeconds
            )));
            String signature = base64Url(sign((header + "." + payload).getBytes(StandardCharsets.UTF_8)));
            return header + "." + payload + "." + signature;
        } catch (Exception ex) {
            throw new IllegalStateException("Unable to issue refresh JWT", ex);
        }
    }

    /**
     * Validates a refresh token (signature + expiry + {@code refresh:true} claim) and
     * returns its subject. Empty if invalid, expired, or not a refresh token.
     */
    public Optional<String> validateRefreshToken(String token) {
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 3) {
                return Optional.empty();
            }
            String headerAndPayload = parts[0] + "." + parts[1];
            String expectedSig = base64Url(sign(headerAndPayload.getBytes(StandardCharsets.UTF_8)));
            if (!expectedSig.equals(parts[2])) {
                return Optional.empty();
            }
            Map<String, Object> payload = objectMapper.readValue(base64UrlDecode(parts[1]), MAP_TYPE);
            if (!Boolean.TRUE.equals(payload.get("refresh"))) {
                return Optional.empty();
            }
            String sub = asString(payload.get("sub"));
            long exp = asLong(payload.get("exp"));
            if (sub.isBlank() || Instant.now().getEpochSecond() >= exp) {
                return Optional.empty();
            }
            return Optional.of(sub);
        } catch (Exception ex) {
            return Optional.empty();
        }
    }

    public long refreshTtlSeconds() {
        return refreshTtlSeconds;
    }

    public Optional<JwtPrincipal> parseAndValidate(String token) {
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 3) {
                return Optional.empty();
            }

            String headerAndPayload = parts[0] + "." + parts[1];
            String expectedSig = base64Url(sign(headerAndPayload.getBytes(StandardCharsets.UTF_8)));
            if (!expectedSig.equals(parts[2])) {
                return Optional.empty();
            }

            Map<String, Object> payload = objectMapper.readValue(base64UrlDecode(parts[1]), MAP_TYPE);
            // A refresh token must never authenticate a normal API request.
            if (Boolean.TRUE.equals(payload.get("refresh"))) {
                return Optional.empty();
            }
            String sub = asString(payload.get("sub"));
            String role = asString(payload.get("role"));
            long exp = asLong(payload.get("exp"));
            if (sub.isBlank() || role.isBlank()) {
                return Optional.empty();
            }
            if (Instant.now().getEpochSecond() >= exp) {
                return Optional.empty();
            }
            return Optional.of(new JwtPrincipal(sub, role));
        } catch (Exception ex) {
            return Optional.empty();
        }
    }

    private byte[] sign(byte[] data) throws Exception {
        Mac mac = Mac.getInstance(HMAC_ALGO);
        mac.init(new SecretKeySpec(secret, HMAC_ALGO));
        return mac.doFinal(data);
    }

    private static String base64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static byte[] base64UrlDecode(String value) {
        return Base64.getUrlDecoder().decode(value);
    }

    private static String asString(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static long asLong(Object value) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        return Long.parseLong(String.valueOf(value));
    }

    public record JwtPrincipal(String email, String role) {
    }
}
