package com.workwell.security;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

public final class SecurityActor {
    private SecurityActor() {
    }

    public static String currentActorOr(String fallback) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            return fallback;
        }
        String name = authentication.getName();
        if (name == null || name.isBlank() || "anonymousUser".equalsIgnoreCase(name)) {
            return fallback;
        }
        return name;
    }

    public static String currentActor() {
        return currentActorOr("system");
    }
}
