package com.workwell.security;

public record DemoUser(String email, String passwordHash, String role) {
}
