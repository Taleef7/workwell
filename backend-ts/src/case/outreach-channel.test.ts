/**
 * OutreachChannel port (#75 E5): the simulated adapters return the right shape per channel,
 * and resolveChannel picks simulated by default / DataChaser only when configured.
 *   node --import tsx --test src/case/outreach-channel.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChannel, simulatedEmailChannel, simulatedSmsChannel, simulatedPhoneChannel, dataChaserChannel, type ChannelType } from "./outreach-channel.ts";

test("simulated email channel returns a SIMULATED record carrying the subject", () => {
  const r = simulatedEmailChannel.send({ channel: "EMAIL", to: "x@workwell-demo.dev", subject: "Hi", body: "Body" });
  assert.equal(r.channel, "EMAIL");
  assert.equal(r.provider, "simulated");
  assert.equal(r.status, "SIMULATED");
  assert.match(r.messageId, /^sim-/);
  assert.equal(r.to, "x@workwell-demo.dev");
  assert.equal(r.errorDetail, null);
});

test("simulated SMS and phone channels are body-only (subject ignored) and SIMULATED", () => {
  for (const [ch, type] of [[simulatedSmsChannel, "SMS"], [simulatedPhoneChannel, "PHONE"]] as const) {
    const r = ch.send({ channel: type as ChannelType, to: "+15550000000", body: "Reminder" });
    assert.equal(r.channel, type);
    assert.equal(r.status, "SIMULATED");
    assert.equal(r.provider, "simulated");
  }
});

test("resolveChannel returns the simulated adapter by default (no DataChaser config)", () => {
  for (const t of ["EMAIL", "SMS", "PHONE"] as ChannelType[]) {
    const ch = resolveChannel(t, {});
    assert.equal(ch.type, t);
    assert.equal(ch.send({ channel: t, to: "x", body: "b" }).provider, "simulated");
  }
});

test("resolveChannel returns the DataChaser stub only when both env vars are set", () => {
  const ch = resolveChannel("SMS", {
    WORKWELL_OUTREACH_DATACHASER_API_KEY: "k",
    WORKWELL_OUTREACH_DATACHASER_BASE_URL: "https://dc.example",
  });
  assert.equal(ch.type, "SMS");
  const r = ch.send({ channel: "SMS", to: "+15550000000", body: "b" });
  assert.equal(r.provider, "datachaser");
  assert.equal(resolveChannel("SMS", { WORKWELL_OUTREACH_DATACHASER_API_KEY: "k" }).send({ channel: "SMS", to: "x", body: "b" }).provider, "simulated");
});

test("dataChaserChannel stub is inert and self-describing (QUEUED, dc- id, stub note)", () => {
  const ch = dataChaserChannel("PHONE", { apiKey: "k", baseUrl: "https://dc.example" });
  const r = ch.send({ channel: "PHONE", to: "+15550000000", body: "b" });
  assert.equal(r.provider, "datachaser");
  assert.equal(r.status, "QUEUED");
  assert.match(r.messageId, /^dc-/);
  assert.match(r.errorDetail ?? "", /stub/i);
});
