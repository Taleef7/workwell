package com.workwell.web;

import com.workwell.security.DemoUser;
import com.workwell.security.DemoUserService;
import com.workwell.security.JwtService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Duration;
import java.util.Arrays;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@Validated
@Tag(name = "Auth", description = "Login, refresh, and logout for the demo workspace")
public class AuthController {
    private static final String REFRESH_COOKIE = "refresh_token";
    private static final String COOKIE_PATH = "/api/auth";

    private final DemoUserService demoUserService;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final boolean cookieSecure;

    public AuthController(
            DemoUserService demoUserService,
            PasswordEncoder passwordEncoder,
            JwtService jwtService,
            @Value("${workwell.auth.cookie-secure:false}") boolean cookieSecure
    ) {
        this.demoUserService = demoUserService;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.cookieSecure = cookieSecure;
    }

    @Operation(
            summary = "Log in",
            description = "Validates credentials, returns a short-lived access token, and sets an "
                    + "HttpOnly refresh token cookie scoped to /api/auth."
    )
    @PostMapping("/api/auth/login")
    public Map<String, String> login(@Valid @RequestBody LoginRequest request, HttpServletResponse response) {
        DemoUser user = demoUserService.findByEmail(request.email())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials"));

        if (!passwordEncoder.matches(request.password(), user.passwordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials");
        }

        String token = jwtService.issueToken(user.email(), user.role());
        setRefreshCookie(response, jwtService.issueRefreshToken(user.email()));
        return Map.of(
                "token", token,
                "email", user.email(),
                "role", user.role()
        );
    }

    @Operation(
            summary = "Refresh access token",
            description = "Reads the HttpOnly refresh token cookie, issues a new access token, "
                    + "and rotates the refresh cookie. Returns 401 if the cookie is missing or invalid."
    )
    @PostMapping("/api/auth/refresh")
    public Map<String, String> refresh(HttpServletRequest request, HttpServletResponse response) {
        String refreshToken = Arrays.stream(Optional.ofNullable(request.getCookies()).orElse(new Cookie[0]))
                .filter(c -> REFRESH_COOKIE.equals(c.getName()))
                .map(Cookie::getValue)
                .findFirst()
                .orElse(null);

        String email = (refreshToken == null ? Optional.<String>empty() : jwtService.validateRefreshToken(refreshToken))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid refresh token"));

        DemoUser user = demoUserService.findByEmail(email)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid refresh token"));

        String token = jwtService.issueToken(user.email(), user.role());
        setRefreshCookie(response, jwtService.issueRefreshToken(user.email()));
        return Map.of(
                "token", token,
                "email", user.email(),
                "role", user.role()
        );
    }

    @Operation(summary = "Log out", description = "Clears the refresh token cookie.")
    @PostMapping("/api/auth/logout")
    public ResponseEntity<Void> logout(HttpServletResponse response) {
        ResponseCookie clear = ResponseCookie.from(REFRESH_COOKIE, "")
                .httpOnly(true)
                .secure(cookieSecure)
                .path(COOKIE_PATH)
                .maxAge(0)
                .sameSite("Lax")
                .build();
        response.addHeader(HttpHeaders.SET_COOKIE, clear.toString());
        return ResponseEntity.noContent().build();
    }

    private void setRefreshCookie(HttpServletResponse response, String refreshToken) {
        ResponseCookie cookie = ResponseCookie.from(REFRESH_COOKIE, refreshToken)
                .httpOnly(true)
                .secure(cookieSecure)
                .path(COOKIE_PATH)
                .maxAge(Duration.ofSeconds(jwtService.refreshTtlSeconds()))
                .sameSite("Lax")
                .build();
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
    }

    public record LoginRequest(@NotBlank String email, @NotBlank String password) {
    }
}
