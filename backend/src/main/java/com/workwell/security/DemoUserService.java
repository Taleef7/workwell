package com.workwell.security;

import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class DemoUserService {
    private final JdbcTemplate jdbcTemplate;

    public DemoUserService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public Optional<DemoUser> findByEmail(String email) {
        return jdbcTemplate.query(
                        "SELECT email, password_hash, role FROM demo_users WHERE LOWER(email) = LOWER(?)",
                        (rs, rowNum) -> new DemoUser(
                                rs.getString("email"),
                                rs.getString("password_hash"),
                                rs.getString("role")
                        ),
                        email
                )
                .stream()
                .findFirst();
    }
}
