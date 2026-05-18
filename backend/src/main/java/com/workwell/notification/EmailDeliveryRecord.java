package com.workwell.notification;

import java.time.Instant;

/**
 * Result of an outreach email send attempt.
 *
 * <p>{@code status} is one of {@code SENT}, {@code FAILED}, or {@code SIMULATED}.
 * On the demo stack the provider is always {@code simulated} and status is
 * {@code SIMULATED} — no real email leaves the process.
 */
public record EmailDeliveryRecord(
        String messageId,
        String toAddress,
        String subject,
        String provider,
        String status,
        Instant sentAt,
        String errorDetail
) {
}
