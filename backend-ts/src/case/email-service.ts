/**
 * Outreach email delivery (#107) — TS port of the Java EmailService, simulated provider.
 *
 * The demo stack runs WORKWELL_EMAIL_PROVIDER=simulated (CLAUDE.md hard rule): no real
 * email is ever sent. `send` records the attempt and returns an EmailDeliveryRecord with
 * status SIMULATED. SendGrid wiring is intentionally NOT ported here — it stays inert
 * until a non-demo deployment, exactly as in Java.
 */
export interface EmailDeliveryRecord {
  toAddress: string;
  subject: string;
  provider: string; // "simulated"
  status: string; // "SIMULATED"
  messageId: string;
  sentAt: string; // ISO-8601
  errorDetail: string | null;
}

export interface EmailService {
  send(toAddress: string, subject: string, body: string): EmailDeliveryRecord;
}

/** The simulated provider: logs nothing externally, returns a SIMULATED delivery record. */
export const simulatedEmailService: EmailService = {
  send(toAddress, subject, _body) {
    return {
      toAddress,
      subject,
      provider: "simulated",
      status: "SIMULATED",
      messageId: `sim-${crypto.randomUUID()}`,
      sentAt: new Date().toISOString(),
      errorDetail: null,
    };
  },
};
