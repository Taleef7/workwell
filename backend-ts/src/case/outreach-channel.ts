/**
 * OutreachChannel port (#75 E5) — multi-channel outreach (email/SMS/phone). Simulated adapters by
 * default (CLAUDE.md hard rule: nothing real is sent on the demo stack). A DataChaser stub stands in
 * for the real provider and is selected ONLY when explicitly configured (inert-unless-configured,
 * mirroring the SendGrid pattern); its transport is a documented stub pending API access (Doug Q4).
 */
import { simulatedEmailService } from "./email-service.ts";

export type ChannelType = "EMAIL" | "SMS" | "PHONE";

export interface OutreachMessage {
  channel: ChannelType;
  to: string;
  subject?: string; // EMAIL only; SMS/PHONE ignore it
  body: string;
}

export interface OutreachDeliveryRecord {
  channel: ChannelType;
  provider: string; // "simulated" | "datachaser"
  status: string; // "SIMULATED" | "SENT" | "FAILED" | "QUEUED"
  messageId: string;
  to: string;
  sentAt: string;
  errorDetail: string | null;
}

export interface OutreachChannel {
  readonly type: ChannelType;
  send(msg: OutreachMessage): OutreachDeliveryRecord;
}

/** Env knobs the channel selector reads (a subset of the worker env). */
export interface ChannelEnv {
  WORKWELL_OUTREACH_DATACHASER_API_KEY?: string;
  WORKWELL_OUTREACH_DATACHASER_BASE_URL?: string;
}

const simRecord = (msg: OutreachMessage, prefix: string): OutreachDeliveryRecord => ({
  channel: msg.channel,
  provider: "simulated",
  status: "SIMULATED",
  messageId: `${prefix}-${crypto.randomUUID()}`,
  to: msg.to,
  sentAt: new Date().toISOString(),
  errorDetail: null,
});

/** EMAIL simulated channel — delegates to the existing simulatedEmailService so email behavior is unchanged. */
export const simulatedEmailChannel: OutreachChannel = {
  type: "EMAIL",
  send(msg) {
    const rec = simulatedEmailService.send(msg.to, msg.subject ?? "", msg.body);
    return { channel: "EMAIL", provider: rec.provider, status: rec.status, messageId: rec.messageId, to: rec.toAddress, sentAt: rec.sentAt, errorDetail: rec.errorDetail };
  },
};

export const simulatedSmsChannel: OutreachChannel = { type: "SMS", send: (msg) => simRecord(msg, "sim-sms") };
export const simulatedPhoneChannel: OutreachChannel = { type: "PHONE", send: (msg) => simRecord(msg, "sim-phone") };

const SIMULATED: Record<ChannelType, OutreachChannel> = {
  EMAIL: simulatedEmailChannel,
  SMS: simulatedSmsChannel,
  PHONE: simulatedPhoneChannel,
};

/**
 * DataChaser stub (#75 E5) — represents MIE's DataChaser provider for all 3 channels. Inert: real
 * HTTP wiring is deferred (Doug Q4). When reached it returns a QUEUED record rather than sending.
 * Only constructed by resolveChannel when fully configured.
 */
export function dataChaserChannel(type: ChannelType, _config: { apiKey: string; baseUrl: string }): OutreachChannel {
  return {
    type,
    send(msg) {
      // STUB: a real implementation would POST to `${_config.baseUrl}` with `_config.apiKey`.
      return { channel: type, provider: "datachaser", status: "QUEUED", messageId: `dc-${crypto.randomUUID()}`, to: msg.to, sentAt: new Date().toISOString(), errorDetail: "datachaser stub — not yet wired (Doug Q4)" };
    },
  };
}

/**
 * Select the channel adapter: the simulated adapter by default; the DataChaser stub ONLY when both
 * WORKWELL_OUTREACH_DATACHASER_API_KEY and _BASE_URL are set (inert-unless-configured).
 */
export function resolveChannel(type: ChannelType, env: ChannelEnv): OutreachChannel {
  const apiKey = (env.WORKWELL_OUTREACH_DATACHASER_API_KEY ?? "").trim();
  const baseUrl = (env.WORKWELL_OUTREACH_DATACHASER_BASE_URL ?? "").trim();
  if (apiKey && baseUrl) return dataChaserChannel(type, { apiKey, baseUrl });
  return SIMULATED[type];
}

export const CHANNEL_TYPES: readonly ChannelType[] = ["EMAIL", "SMS", "PHONE"];
export const isChannelType = (v: unknown): v is ChannelType => typeof v === "string" && (CHANNEL_TYPES as readonly string[]).includes(v);
