package com.workwell.web;

import com.workwell.security.DemoUser;
import com.workwell.security.DemoUserService;
import com.workwell.security.JwtService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@Validated
public class AuthController {
    private final DemoUserService demoUserService;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;

    public AuthController(DemoUserService demoUserService, PasswordEncoder passwordEncoder, JwtService jwtService) {
        this.demoUserService = demoUserService;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
    }

    @PostMapping("/api/auth/login")
    public Map<String, String> login(@Valid @RequestBody LoginRequest request) {
        DemoUser user = demoUserService.findByEmail(request.email())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials"));

        if (!passwordEncoder.matches(request.password(), user.passwordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials");
        }

        String token = jwtService.issueToken(user.email(), user.role());
        return Map.of(
                "token", token,
                "email", user.email(),
                "role", user.role()
        );
    }

    public record LoginRequest(@NotBlank String email, @NotBlank String password) {
    }
}
