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

/** Env knobs the email-provider selector reads (a subset of the worker env). */
export interface EmailEnv {
  WORKWELL_EMAIL_PROVIDER?: string;
  WORKWELL_EMAIL_SENDGRID_API_KEY?: string;
}

/**
 * SendGrid provider stub (H2) — inert. A real implementation would POST the message to the SendGrid
 * v3 API using the api key; until then it returns a QUEUED record (no real HTTP), mirroring the
 * DataChaser channel stub (ADR-011 inert-unless-configured). Only constructed by resolveEmailService
 * when the provider is "sendgrid" AND the api key is set. This closes the prior docs↔code gap where
 * DEPLOY.md described SendGrid wiring that did not exist in backend-ts.
 */
export function sendgridEmailService(_config: { apiKey: string }): EmailService {
  return {
    send(toAddress, subject, _body) {
      // STUB: a real send would call the SendGrid v3 API with `_config.apiKey`.
      return {
        toAddress,
        subject,
        provider: "sendgrid",
        status: "QUEUED",
        messageId: `sg-${crypto.randomUUID()}`,
        sentAt: new Date().toISOString(),
        errorDetail: "sendgrid stub — not yet wired",
      };
    },
  };
}

/**
 * Select the email provider: simulated by DEFAULT (CLAUDE.md hard rule — must stay simulated on the
 * demo stack). The SendGrid stub is selected ONLY when WORKWELL_EMAIL_PROVIDER=sendgrid AND
 * WORKWELL_EMAIL_SENDGRID_API_KEY is set; provider=sendgrid without a key degrades back to simulated.
 */
export function resolveEmailService(env: EmailEnv): EmailService {
  const provider = (env.WORKWELL_EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = (env.WORKWELL_EMAIL_SENDGRID_API_KEY ?? "").trim();
  if (provider === "sendgrid" && apiKey) return sendgridEmailService({ apiKey });
  return simulatedEmailService;
}
