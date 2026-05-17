package com.workwell.notification;

import com.sendgrid.Method;
import com.sendgrid.Request;
import com.sendgrid.Response;
import com.sendgrid.SendGrid;
import com.sendgrid.helpers.mail.Mail;
import com.sendgrid.helpers.mail.objects.Content;
import com.sendgrid.helpers.mail.objects.Email;
import java.io.IOException;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Outreach email delivery with a provider abstraction.
 *
 * <p>The demo stack runs with {@code workwell.email.provider=simulated} (the default and a
 * CLAUDE.md hard rule): nothing is sent, the attempt is logged, and a {@code SIMULATED}
 * delivery record is returned so the Admin UI can show a visible delivery history without
 * any real email leaving the process.
 *
 * <p>SendGrid wiring exists for post-demo / non-demo use only. It is exercised solely when
 * {@code workwell.email.provider=sendgrid} AND {@code workwell.email.sendgrid.api-key} is
 * set. It must not be activated on the demo stack.
 */
@Service
public class EmailService {

    private static final Logger log = LoggerFactory.getLogger(EmailService.class);

    private final String provider;
    private final String sendgridApiKey;
    private final String fromAddress;
    private final String fromName;

    public EmailService(
            @Value("${workwell.email.provider:simulated}") String provider,
            @Value("${workwell.email.sendgrid.api-key:}") String sendgridApiKey,
            @Value("${workwell.email.from-address:noreply@workwell-demo.dev}") String fromAddress,
            @Value("${workwell.email.from-name:WorkWell Measure Studio}") String fromName
    ) {
        this.provider = provider == null || provider.isBlank() ? "simulated" : provider.trim().toLowerCase();
        this.sendgridApiKey = sendgridApiKey == null ? "" : sendgridApiKey.trim();
        this.fromAddress = fromAddress == null || fromAddress.isBlank() ? "noreply@workwell-demo.dev" : fromAddress.trim();
        this.fromName = fromName == null || fromName.isBlank() ? "WorkWell Measure Studio" : fromName.trim();
    }

    public EmailDeliveryRecord send(String toAddress, String subject, String bodyText) {
        String messageId = "msg-" + UUID.randomUUID().toString().substring(0, 8);
        if ("sendgrid".equals(provider)) {
            if (sendgridApiKey.isBlank()) {
                // Provider explicitly requested but unconfigured — degrade safely to simulated
                // rather than fail the outreach action.
                log.warn("workwell.email.provider=sendgrid but no API key configured; falling back to simulated send");
                return simulate(toAddress, subject, messageId);
            }
            return sendViaSendGrid(toAddress, subject, bodyText, messageId);
        }
        return simulate(toAddress, subject, messageId);
    }

    private EmailDeliveryRecord simulate(String to, String subject, String messageId) {
        log.info("[SIMULATED EMAIL] to={} subject={}", to, subject);
        return new EmailDeliveryRecord(messageId, to, subject, "simulated", "SIMULATED", Instant.now(), null);
    }

    private EmailDeliveryRecord sendViaSendGrid(String to, String subject, String body, String messageId) {
        try {
            Email from = new Email(fromAddress, fromName);
            Email toEmail = new Email(to);
            Content content = new Content("text/plain", body == null ? "" : body);
            Mail mail = new Mail(from, subject, toEmail, content);

            SendGrid sg = new SendGrid(sendgridApiKey);
            Request request = new Request();
            request.setMethod(Method.POST);
            request.setEndpoint("mail/send");
            request.setBody(mail.build());

            Response response = sg.api(request);
            boolean ok = response.getStatusCode() < 300;
            String status = ok ? "SENT" : "FAILED";
            log.info("SendGrid delivery: {} -> {} (HTTP {})", to, status, response.getStatusCode());
            return new EmailDeliveryRecord(
                    messageId,
                    to,
                    subject,
                    "sendgrid",
                    status,
                    Instant.now(),
                    ok ? null : ("HTTP " + response.getStatusCode() + ": " + response.getBody())
            );
        } catch (IOException ex) {
            log.error("SendGrid delivery failed for {}: {}", to, ex.getMessage());
            return new EmailDeliveryRecord(messageId, to, subject, "sendgrid", "FAILED", Instant.now(), ex.getMessage());
        }
    }
}
