package com.workwell.web.filter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.benmanes.caffeine.cache.Cache;
import com.workwell.config.RateLimitConfig;
import io.github.bucket4j.Bucket;
import io.github.bucket4j.ConsumptionProbe;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Per-bucket rate limiting. Registered inside the Spring Security chain (after the
 * JWT auth filter) so the authenticated principal is available for per-user keys.
 *
 * <p>Skips CORS preflight (OPTIONS) and any non-{@code /api} path. Can be globally
 * disabled via {@code workwell.ratelimit.enabled=false} (used by the test profile,
 * whose suite issues far more than 200 requests/min per JVM through MockMvc).
 */
public class RateLimitFilter extends OncePerRequestFilter {

    private final Cache<String, Bucket> cache;
    private final ObjectMapper mapper;
    private final boolean enabled;

    public RateLimitFilter(Cache<String, Bucket> rateLimitCache, ObjectMapper mapper, boolean enabled) {
        this.cache = rateLimitCache;
        this.mapper = mapper;
        this.enabled = enabled;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!enabled) {
            return true;
        }
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }
        String uri = request.getRequestURI();
        return uri == null || !uri.startsWith("/api");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String key = buildKey(request);
        Bucket bucket = cache.get(key, k -> selectBucket(request));

        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);
        if (probe.isConsumed()) {
            chain.doFilter(request, response);
            return;
        }

        long retryAfterSeconds = TimeUnit.NANOSECONDS.toSeconds(probe.getNanosToWaitForRefill());
        if (retryAfterSeconds < 1) {
            retryAfterSeconds = 1;
        }
        response.setStatus(429);
        response.setContentType("application/json");
        response.setHeader("Retry-After", String.valueOf(retryAfterSeconds));
        mapper.writeValue(response.getWriter(), Map.of(
                "error", "rate_limit_exceeded",
                "retryAfterSeconds", retryAfterSeconds
        ));
    }

    private String currentUser(HttpServletRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && auth.getName() != null
                && !"anonymousUser".equals(auth.getName())) {
            return auth.getName();
        }
        return request.getRemoteAddr();
    }

    private String buildKey(HttpServletRequest request) {
        String uri = request.getRequestURI();
        // Per-endpoint buckets are tracked separately; the default bucket keys by user
        // only so the 200/min limit is shared across the whole API per user.
        if (uri.contains("/auth/login")) {
            return "login:" + request.getRemoteAddr();
        }
        String user = currentUser(request);
        if (uri.contains("/runs/manual")) {
            return "runs-manual:" + user;
        }
        if (uri.contains("/exports/")) {
            return "exports:" + user;
        }
        return "default:" + user;
    }

    private Bucket selectBucket(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri.contains("/auth/login")) {
            return RateLimitConfig.loginBucket();
        }
        if (uri.contains("/runs/manual")) {
            return RateLimitConfig.runTriggerBucket();
        }
        if (uri.contains("/exports/")) {
            return RateLimitConfig.exportBucket();
        }
        return RateLimitConfig.defaultBucket();
    }
}
