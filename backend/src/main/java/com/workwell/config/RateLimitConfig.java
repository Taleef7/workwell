package com.workwell.config;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import io.github.bucket4j.Bucket;
import java.time.Duration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * In-memory (Caffeine-backed) rate limit buckets. Per-JVM only — acceptable for the
 * single-machine demo stack. See Sprint 4 recommendations for the Redis upgrade path.
 */
@Configuration
public class RateLimitConfig {

    @Bean
    public Cache<String, Bucket> rateLimitCache() {
        return Caffeine.newBuilder()
                .expireAfterAccess(Duration.ofHours(1))
                .maximumSize(10_000)
                .build();
    }

    /** Login: 10 attempts per IP per minute. */
    public static Bucket loginBucket() {
        return Bucket.builder()
                .addLimit(limit -> limit.capacity(10).refillIntervally(10, Duration.ofMinutes(1)))
                .build();
    }

    /** Manual run trigger: 5 per user per hour. */
    public static Bucket runTriggerBucket() {
        return Bucket.builder()
                .addLimit(limit -> limit.capacity(5).refillIntervally(5, Duration.ofHours(1)))
                .build();
    }

    /** Exports: 20 per user per 10 minutes. */
    public static Bucket exportBucket() {
        return Bucket.builder()
                .addLimit(limit -> limit.capacity(20).refillIntervally(20, Duration.ofMinutes(10)))
                .build();
    }

    /** Everything else: 200 per user per minute, shared across the whole API. */
    public static Bucket defaultBucket() {
        return Bucket.builder()
                .addLimit(limit -> limit.capacity(200).refillIntervally(200, Duration.ofMinutes(1)))
                .build();
    }
}
